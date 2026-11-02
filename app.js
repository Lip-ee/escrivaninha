/* Escrivaninha — app de escrita que lê e salva num repositório privado do GitHub.
 * Nada do livro fica neste código: roteiro, bíblia e manuscrito vêm do repositório,
 * lidos com o token que o autor cola na primeira vez (guardado só neste navegador). */
'use strict';
(() => {

/* ============================== utilidades ============================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmtN = n => n.toLocaleString('pt-BR');
const dobrar = s => String(s).split('').map(ch => ch.normalize('NFD')[0].toLowerCase()).join('');
const contarPalavras = s => (String(s).match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
const diaISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = () => diaISO(new Date());
const hora = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { if (typeof S !== 'undefined' && S.esquecendo) return false; try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sem armazenamento */ } },
  keys(prefixo) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefixo)) out.push(k); } } catch { /* idem */ }
    return out;
  },
};

function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ============================== estado ============================== */
const CAMINHO_DADOS = 'dados/capitulos.json';
const CAMINHO_PROG = 'manuscrito/progresso.json';
const caminhoCap = n => `manuscrito/cap-${pad(n)}.md`;
const PREFS_PADRAO = { fonte: 19, travessao: true, aspas: true, reticencias: true, tema: 'polen', painel: true };
const STATUS_TXT = { vazio: 'não começado', rascunho: 'rascunho', revisar: 'precisa revisar', pronto: 'pronto' };
const K_ROT = { p: 'Plantar', t: 'Reaparece', x: 'Paga' };
const K_AQUI = { p: 'Aqui você planta', t: 'Aqui reaparece', x: 'Aqui paga' };

const S = {
  cfg: LS.get('esc.cfg'),
  prefs: (() => { const p = { ...PREFS_PADRAO, ...(LS.get('esc.prefs') || {}) }; if (p.tema !== 'noite') p.tema = p.tema === 'escuro' ? 'noite' : 'polen'; return p; })(),
  dados: null, caps: [], porN: new Map(), pessoas: new Map(),
  arquivos: {},          // n -> sha no GitHub
  textos: {},            // n -> { texto, sha, dirty }
  prog: { doc: null, sha: null, dirty: false },
  atual: null, aba: 'roteiro',
  online: true, erro: null, conflito: false, enviando: 0, enviandoProg: false, ultimoSalvo: null,
  filas: {}, timers: {}, primeiroSujo: {}, palavrasAoAbrir: {}, tentativas: {},
  local: false,
};

/* ============================== GitHub ============================== */
const API = {
  async req(caminho, { method = 'GET', body, query } = {}) {
    const [dono, nome] = S.cfg.repo.split('/');
    let url = `https://api.github.com/repos/${dono}/${nome}${caminho ? '/' + caminho : ''}`;
    if (query) url += '?' + new URLSearchParams(query);
    let r;
    try {
      r = await fetch(url, {
        method, cache: 'no-store',
        headers: {
          Authorization: `Bearer ${S.cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      const e = new Error('Sem conexão com o GitHub.'); e.offline = true; throw e;
    }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).message || ''; } catch { /* corpo vazio */ }
      const e = new Error(msg || `Erro ${r.status}`); e.status = r.status; throw e;
    }
    return r.status === 204 ? null : r.json();
  },
  async ler(caminho, ref) {
    try {
      const j = await this.req(`contents/${encodeURI(caminho)}`, { query: { ref: ref || S.cfg.branch } });
      if (Array.isArray(j)) throw new Error(`${caminho} é uma pasta`);
      if (j.encoding === 'base64' && j.content) return { texto: b64dec(j.content), sha: j.sha };
      const blob = await this.req(`git/blobs/${j.sha}`);
      return { texto: b64dec(blob.content), sha: j.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  async listar(pasta) {
    try {
      const j = await this.req(`contents/${pasta}`, { query: { ref: S.cfg.branch } });
      return Array.isArray(j) ? j : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  },
  fila: Promise.resolve(),
  gravar(caminho, texto, sha, mensagem) {
    // O GitHub recusa (409) dois commits ao mesmo tempo no mesmo branch: grava um de cada vez.
    const p = this.fila.then(() => this.req(`contents/${encodeURI(caminho)}`, {
      method: 'PUT',
      body: { message: mensagem, content: b64enc(texto), branch: S.cfg.branch, ...(sha ? { sha } : {}) },
    })).then(j => j.content.sha);
    this.fila = p.catch(() => {});
    return p;
  },
  async historico(caminho) {
    return this.req('commits', { query: { path: caminho, sha: S.cfg.branch, per_page: 40 } });
  },
  async testar() {
    const d = await this.ler(CAMINHO_DADOS);
    if (!d) { const e = new Error('Esse repositório não tem o arquivo dados/capitulos.json.'); e.status = 404; throw e; }
    return d;
  },
};

/* Modo local (abrir com ?local): guarda tudo no navegador. Serve para testar sem token. */
function usarBackendLocal() {
  const pre = 'esc.fake.';
  const hash = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
  API.ler = async caminho => {
    if (caminho === CAMINHO_DADOS) {
      const r = await fetch('../dados/capitulos.json', { cache: 'no-store' });
      if (!r.ok) return null;
      return { texto: await r.text(), sha: 'dados' };
    }
    return LS.get(pre + caminho);
  };
  API.listar = async pasta => LS.keys(pre + pasta + '/').map(k => ({ name: k.slice((pre + pasta + '/').length), sha: LS.get(k).sha }));
  API.gravar = async (caminho, texto, sha) => {
    const atual = LS.get(pre + caminho);
    if ((atual?.sha || null) !== (sha || null)) { const e = new Error('Conflito'); e.status = 409; throw e; }
    const novo = hash(texto + Math.random());
    LS.set(pre + caminho, { texto, sha: novo });
    return novo;
  };
  API.historico = async () => [];
  API.testar = async () => API.ler(CAMINHO_DADOS);
}

/* ============================== telas ============================== */
function mostrarTela(qual) {
  $('#tela-conectar').hidden = qual !== 'conectar';
  $('#tela-carregando').hidden = qual !== 'carregando';
  $('#tela-app').hidden = qual !== 'app';
}

function aviso(msg, ms = 3200) {
  const el = $('#aviso');
  el.textContent = msg; el.hidden = false;
  clearTimeout(S.timers.aviso);
  S.timers.aviso = setTimeout(() => { el.hidden = true; }, ms);
}

function msgErro(e) {
  if (e.offline) return 'Sem conexão com a internet.';
  if (e.status === 401) return 'Token inválido ou expirado. Crie um novo e cole aqui.';
  if (e.status === 403) return 'O token não tem permissão. Ele precisa de Contents: Read and write nesse repositório.';
  if (e.status === 404) return e.message && !/^Not Found$/i.test(e.message) ? e.message : 'Não achei o repositório. Confira o nome (dono/repositório) e se o token tem acesso a ele.';
  return e.message || 'Erro desconhecido.';
}

function mostrarConectar(erro) {
  mostrarTela('conectar');
  if (S.cfg?.repo) $('#in-repo').value = S.cfg.repo;
  if (S.cfg?.branch) $('#in-branch').value = S.cfg.branch;
  const el = $('#conectar-erro');
  el.hidden = !erro; el.textContent = erro || '';
  setTimeout(() => ($('#in-repo').value ? $('#in-token') : $('#in-repo')).focus(), 50);
}

$('#form-conectar').addEventListener('submit', async ev => {
  ev.preventDefault();
  const repo = $('#in-repo').value.trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const token = $('#in-token').value.trim();
  const branch = $('#in-branch').value.trim() || 'main';
  const erroEl = $('#conectar-erro');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { erroEl.textContent = 'Escreva o repositório como dono/nome.'; erroEl.hidden = false; return; }
  const btn = $('#btn-conectar'); btn.disabled = true; btn.textContent = 'Conectando…';
  S.cfg = { repo, token, branch };
  try {
    await API.testar();
    LS.set('esc.cfg', S.cfg);
    $('#in-token').value = '';
    await iniciar();
  } catch (e) {
    erroEl.textContent = msgErro(e); erroEl.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Conectar';
  }
});

/* ============================== carga ============================== */
function progVazio() { return { versao: 1, capitulos: {}, diario: {}, pendencias: [], config: { metaDiaria: 500, atualizado: 0 } }; }

function normalizarProg(doc) {
  const d = { ...progVazio(), ...(doc || {}) };
  d.capitulos ||= {}; d.diario ||= {}; d.pendencias ||= []; d.config = { metaDiaria: 500, atualizado: 0, ...(d.config || {}) };
  return d;
}

function mesclarProg(remoto, local) {
  const out = normalizarProg(JSON.parse(JSON.stringify(remoto)));
  const l = normalizarProg(local);
  for (const [k, v] of Object.entries(l.capitulos)) {
    const r = out.capitulos[k];
    if (!r || (v.atualizado || 0) > (r.atualizado || 0)) out.capitulos[k] = v;
  }
  for (const [dia, v] of Object.entries(l.diario)) {
    const r = out.diario[dia] || { base: {}, atual: {} };
    out.diario[dia] = { base: { ...v.base, ...r.base }, atual: { ...r.atual, ...v.atual } };
  }
  const porId = new Map(out.pendencias.map(p => [p.id, p]));
  for (const p of l.pendencias) {
    const r = porId.get(p.id);
    if (!r || (p.atualizado || 0) > (r.atualizado || 0)) porId.set(p.id, p);
  }
  out.pendencias = [...porId.values()];
  if ((l.config.atualizado || 0) > (out.config.atualizado || 0)) out.config = l.config;
  return out;
}

function montarDados(d) {
  S.dados = d;
  S.caps = d.capitulos;
  S.porN = new Map(d.capitulos.map(c => [c.n, c]));
  S.pessoas = new Map((d.biblia?.personagens || []).map(p => [p.id, p]));
  const ps = d.biblia?.personagens || [];
  const claro = ps.map(p => `--c-${p.id}:${p.cor[0]}`).join(';');
  const escuro = ps.map(p => `--c-${p.id}:${p.cor[1] || p.cor[0]}`).join(';');
  let st = $('#estilo-pessoas');
  if (!st) { st = document.createElement('style'); st.id = 'estilo-pessoas'; document.head.appendChild(st); }
  st.textContent = `:root{${claro}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${escuro}}}:root[data-theme="dark"]{${escuro}}`;
}

async function carregarTudo() {
  const dados = await API.testar();
  const d = JSON.parse(dados.texto);
  LS.set('esc.dados', d);
  montarDados(d);

  const [prog, lista] = await Promise.all([API.ler(CAMINHO_PROG), API.listar('manuscrito')]);
  const progLocal = LS.get('esc.prog');
  if (prog) {
    let doc = normalizarProg(JSON.parse(prog.texto));
    if (progLocal?.dirty && progLocal.doc) doc = mesclarProg(doc, progLocal.doc);
    S.prog = { doc, sha: prog.sha, dirty: !!progLocal?.dirty };
  } else {
    S.prog = { doc: normalizarProg(progLocal?.doc), sha: null, dirty: true };
  }
  S.arquivos = {};
  ultimaChecagem = Date.now();
  for (const f of lista) {
    const m = /^cap-(\d+)\.md$/.exec(f.name);
    if (m) S.arquivos[+m[1]] = f.sha;
  }
  // rascunhos locais que ainda não subiram
  for (const k of LS.keys('esc.cap.')) {
    const n = +k.slice('esc.cap.'.length);
    const l = LS.get(k);
    if (l?.dirty && (l.sha || null) === (S.arquivos[n] || null)) {
      S.textos[n] = { texto: l.texto, sha: l.sha || null, dirty: true };
    }
  }
}

function carregarDoCache() {
  const d = LS.get('esc.dados');
  if (!d) return false;
  montarDados(d);
  const pl = LS.get('esc.prog');
  S.prog = { doc: normalizarProg(pl?.doc), sha: pl?.sha || null, dirty: !!pl?.dirty };
  for (const k of LS.keys('esc.cap.')) {
    const n = +k.slice('esc.cap.'.length);
    const l = LS.get(k);
    if (l) { S.textos[n] = { texto: l.texto, sha: l.sha || null, dirty: !!l.dirty }; if (l.sha) S.arquivos[n] = l.sha; }
  }
  S.online = false;
  return true;
}

async function iniciar() {
  aplicarPrefs();
  if (new URLSearchParams(location.search).has('local')) {
    S.local = true; S.cfg = { repo: 'local/teste', branch: 'main', token: '-' }; usarBackendLocal();
  }
  if (!S.cfg?.token) return mostrarConectar();
  mostrarTela('carregando');
  try {
    await carregarTudo();
  } catch (e) {
    if (!e.offline) return mostrarConectar(msgErro(e));
    if (!carregarDoCache()) {
      $('#carregando-txt').textContent = 'Sem conexão, e este computador ainda não tem uma cópia do livro. Conecte-se à internet e recarregue.';
      return;
    }
    aviso('Sem conexão: abrindo a cópia deste computador. O que você escrever sobe quando a internet voltar.', 6000);
  }
  montarApp();
}

/* ============================== app ============================== */
const texto = $('#texto');
const rolagem = $('.folha-inner');
const cap = () => S.porN.get(S.atual);
const ehEstreito = () => window.matchMedia('(max-width: 900px)').matches;

function nomeFoco(id) {
  const p = S.pessoas.get(id);
  return p ? p.nome.split(' ')[0] : id;
}
function pontoCor() { return ''; }

function capProg(n) {
  const k = String(n);
  return (S.prog.doc.capitulos[k] ||= { status: null, checks: [], notas: '', palavras: 0, atualizado: 0 });
}
function statusDe(n) {
  const p = S.prog.doc.capitulos[String(n)];
  if (p?.status && p.status !== 'vazio') return p.status;
  const w = S.textos[n] ? contarPalavras(S.textos[n].texto) : (p?.palavras || 0);
  return w > 0 ? 'rascunho' : 'vazio';
}
function palavrasDe(n) { return S.textos[n] ? contarPalavras(S.textos[n].texto) : (S.prog.doc.capitulos[String(n)]?.palavras || 0); }

function montarApp() {
  mostrarTela('app');
  let n = +(/^#cap-(\d+)$/.exec(location.hash)?.[1] || 0) || LS.get('esc.ultimo') || 1;
  if (!S.porN.has(n)) n = 1;
  if (S.dados.mapa) { const a = $('#lnk-mapa'); a.href = S.dados.mapa; a.hidden = false; }
  abrir(n);
  for (const k in S.textos) if (S.textos[k].dirty) agendarEnvio(+k);
  if (S.prog.dirty) agendarProg();
  atualizarSync();
}

/* ---------- abrir capítulo ---------- */
async function carregarTexto(n) {
  const local = LS.get('esc.cap.' + n);
  const remSha = S.arquivos[n] || null;
  if (S.textos[n]?.dirty) return S.textos[n];
  if (local?.dirty) {
    S.textos[n] = { texto: local.texto, sha: local.sha || null, dirty: true };
    if ((local.sha || null) === remSha || !S.online) { agendarEnvio(n); return S.textos[n]; }
    const rem = await API.ler(caminhoCap(n));
    await resolverConflito(n, rem);
    return S.textos[n];
  }
  const mem = S.textos[n];
  if (mem && (mem.sha || null) === remSha) return mem;
  if (local && (local.sha || null) === remSha) { S.textos[n] = { texto: local.texto, sha: remSha, dirty: false }; return S.textos[n]; }
  if (!remSha) { S.textos[n] = { texto: '', sha: null, dirty: false }; return S.textos[n]; }
  try {
    const rem = await API.ler(caminhoCap(n));
    S.textos[n] = { texto: rem ? rem.texto : '', sha: rem ? rem.sha : null, dirty: false };
    if (rem) S.arquivos[n] = rem.sha;
    guardarLocal(n);
    return S.textos[n];
  } catch (e) {
    if (e.offline && local) { S.textos[n] = { texto: local.texto, sha: local.sha || null, dirty: false }; S.online = false; return S.textos[n]; }
    throw e;
  }
}

function guardarLocal(n) {
  const t = S.textos[n];
  if (t) LS.set('esc.cap.' + n, { texto: t.texto, sha: t.sha || null, dirty: !!t.dirty, ts: Date.now() });
}

async function abrir(n, { selecionar = null, focar = true } = {}) {
  n = Math.max(1, Math.min(S.caps.length, n));
  if (S.atual && S.atual !== n && S.textos[S.atual]?.dirty) { guardarLocal(S.atual); enfileirar(S.atual); }
  S.atual = n;
  LS.set('esc.ultimo', n);
  history.replaceState(null, '', '#cap-' + n);
  const c = cap();
  renderCabecalho(c);
  renderPainel();
  if (!$('#gaveta').hidden) renderLista();
  $('#anterior').hidden = true;
  texto.disabled = true; texto.value = ''; texto.placeholder = 'Carregando…';
  crescer();
  await atualizarDoGitHub();
  if (S.atual !== n) return;
  let t;
  try { t = await carregarTexto(n); }
  catch (e) { if (S.atual === n) texto.placeholder = 'Não consegui carregar este capítulo. ' + msgErro(e); return; }
  if (S.atual !== n) return;
  texto.value = t.texto; texto.disabled = false; texto.placeholder = 'Comece a escrever…';
  S.palavrasAoAbrir[n] ??= contarPalavras(t.texto);
  crescer(); renderContagem(); renderStatus();
  renderAnterior(n);
  if (selecionar) {
    texto.focus({ preventScroll: true });
    texto.setSelectionRange(selecionar[0], selecionar[1]);
    rolarAteCursor();
  } else if (focar && !ehEstreito()) {
    const pos = Math.min(LS.get('esc.pos.' + n) ?? texto.value.length, texto.value.length);
    texto.focus({ preventScroll: true });
    texto.setSelectionRange(pos, pos);
    rolarAteCursor();
  } else {
    rolagem.scrollTop = 0;
  }
}

function renderCabecalho(c) {
  $('#barra-titulo').innerHTML = `<b>${c.n}</b> · ${esc(c.titulo)}`;
  $('#f-eyebrow').textContent = `${S.dados.partes[c.parte]} · ${c.quando}`;
  $('#f-titulo').textContent = c.titulo;
  document.title = `${c.n}. ${c.titulo} · Escrivaninha`;
  $('#btn-ant').disabled = c.n <= 1;
  $('#btn-prox').disabled = c.n >= S.caps.length;
}

async function renderAnterior(n) {
  const box = $('#anterior');
  if (n <= 1) { box.hidden = true; return; }
  const ant = n - 1;
  let t = S.textos[ant];
  if (!t && S.arquivos[ant]) { try { t = await carregarTexto(ant); } catch { t = null; } }
  if (S.atual !== n) return;
  const txt = (t?.texto || '').trim();
  if (!txt) { box.hidden = true; return; }
  const pars = txt.split(/\n+/).filter(p => p.trim()).slice(-3);
  $('#anterior-txt').innerHTML = `<p class="rotulo">${ant} · ${esc(S.porN.get(ant).titulo)}</p>` + pars.map(p => `<p>${esc(p)}</p>`).join('');
  box.hidden = false;
}

/* ---------- editor ---------- */
function crescer() {
  const topo = rolagem.scrollTop;
  texto.style.height = 'auto';
  texto.style.height = texto.scrollHeight + 'px';
  rolagem.scrollTop = topo;
}

let espelho = null;
function rolarAteCursor() {
  if (!espelho) { espelho = document.createElement('div'); espelho.setAttribute('aria-hidden', 'true'); document.body.appendChild(espelho); }
  const cs = getComputedStyle(texto);
  Object.assign(espelho.style, {
    position: 'absolute', visibility: 'hidden', top: '0', left: '-99999px', width: texto.clientWidth + 'px',
    font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', padding: '0',
  });
  espelho.textContent = texto.value.slice(0, texto.selectionStart) + '​';
  const y = texto.offsetTop + espelho.scrollHeight;
  rolagem.scrollTop = Math.max(0, y - rolagem.clientHeight * 0.45);
}

function manterCursorVisivel() {
  if (texto.selectionStart !== texto.value.length) return;
  const y = texto.offsetTop + texto.offsetHeight;
  if (y - rolagem.scrollTop > rolagem.clientHeight * 0.82) rolagem.scrollTop = y - rolagem.clientHeight * 0.6;
}

function inserir(t) {
  let ok = false;
  try { ok = document.execCommand('insertText', false, t); } catch { ok = false; }
  if (!ok) {
    texto.setRangeText(t, texto.selectionStart, texto.selectionEnd, 'end');
    texto.dispatchEvent(new Event('input'));
  }
}

/* Tipografia ao digitar: -- vira —, ... vira …, aspas retas viram curvas.
 * Corrige o trecho recém-inserido (funciona com teclado, corretor do celular e IME). */
let ajustando = false;
function aplicarTipografia(qtdInserida) {
  const fim = texto.selectionStart;
  if (fim !== texto.selectionEnd) return;
  const ini = Math.max(0, fim - qtdInserida - 2);
  const trecho = texto.value.slice(ini, fim);
  let novo = trecho;
  if (S.prefs.aspas) {
    novo = novo.replace(/"/g, (m, pos, str) => {
      const ant = pos > 0 ? str[pos - 1] : (texto.value[ini - 1] || '');
      return !ant || /[\s(\[{—–-]/.test(ant) ? '“' : '”';
    });
  }
  if (S.prefs.travessao) novo = novo.replace(/--/g, '—');
  if (S.prefs.reticencias) novo = novo.replace(/\.\.\./g, '…');
  if (novo === trecho) return;
  ajustando = true;
  try { texto.setSelectionRange(ini, fim); inserir(novo); } finally { ajustando = false; }
}
texto.addEventListener('compositionend', e => { if (e.data) aplicarTipografia(e.data.length); });

texto.addEventListener('input', e => {
  if (!ajustando && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText')) aplicarTipografia((e.data || '').length || 1);
  const n = S.atual, t = S.textos[n];
  if (!t || texto.disabled) return;
  t.texto = texto.value; t.dirty = true;
  crescer(); manterCursorVisivel();
  clearTimeout(S.timers.local);
  S.timers.local = setTimeout(() => { guardarLocal(n); contarEAtualizar(n); }, 400);
  agendarEnvio(n);
});

const guardarPos = () => { if (S.atual && !texto.disabled) LS.set('esc.pos.' + S.atual, texto.selectionStart); };
texto.addEventListener('keyup', () => { clearTimeout(S.timers.pos); S.timers.pos = setTimeout(guardarPos, 600); });
texto.addEventListener('click', guardarPos);
texto.addEventListener('blur', () => { guardarPos(); if (S.atual && S.textos[S.atual]?.dirty) guardarLocal(S.atual); });

function contarEAtualizar(n) {
  const w = contarPalavras(S.textos[n].texto);
  const p = capProg(n);
  p.palavras = w;
  if ((!p.status || p.status === 'vazio') && w > 0) p.status = 'rascunho';
  registrarDia(n, w);
  mexerProg(n);
  renderContagem(); renderStatus();
  if (!$('#gaveta').hidden) renderLista();
}

function registrarDia(n, w) {
  const d = (S.prog.doc.diario[hoje()] ||= { base: {}, atual: {} });
  const k = String(n);
  if (d.base[k] === undefined) d.base[k] = S.palavrasAoAbrir[n] ?? w;
  d.atual[k] = w;
}
function palavrasDoDia(dia) {
  const d = S.prog.doc.diario[dia];
  if (!d) return 0;
  let s = 0;
  for (const k in d.atual) s += Math.max(0, d.atual[k] - (d.base[k] ?? d.atual[k]));
  return s;
}
function sequencia() {
  const d = new Date();
  if (palavrasDoDia(diaISO(d)) === 0) d.setDate(d.getDate() - 1);
  let n = 0;
  while (palavrasDoDia(diaISO(d)) > 0) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function renderContagem() {
  if (!S.atual || !S.textos[S.atual]) { $('#contagem').textContent = ''; return; }
  const w = contarPalavras(S.textos[S.atual].texto);
  $('#contagem').textContent = `${fmtN(w)} ${w === 1 ? 'palavra' : 'palavras'}`;
}

function renderStatus() {
  const sel = $('#sel-status');
  if (sel) sel.value = statusDe(S.atual);
}

/* ============================== salvar ============================== */
function pendente() { return Object.values(S.textos).some(t => t.dirty) || S.prog.dirty; }

function agendarEnvio(n, imediato = false) {
  clearTimeout(S.timers['cap' + n]);
  S.primeiroSujo[n] ||= Date.now();
  const longo = Date.now() - S.primeiroSujo[n] > 4 * 60e3;
  S.timers['cap' + n] = setTimeout(() => enfileirar(n), imediato || longo ? 0 : 30e3);
  atualizarSync();
}

function enfileirar(n) {
  clearTimeout(S.timers['cap' + n]);
  S.filas[n] = (S.filas[n] || Promise.resolve()).then(() => enviarCap(n)).catch(() => {});
  return S.filas[n];
}

async function enviarCap(n) {
  const t = S.textos[n];
  if (!t || !t.dirty || S.conflito) return;
  const conteudo = t.texto, base = t.sha;
  const c = S.porN.get(n);
  S.enviando++; atualizarSync();
  try {
    const sha = await API.gravar(caminhoCap(n), conteudo, base, `Cap. ${n}: ${c.titulo} (${contarPalavras(conteudo)} palavras)`);
    t.sha = sha; S.arquivos[n] = sha; delete S.tentativas[n];
    if (t.texto === conteudo) { t.dirty = false; delete S.primeiroSujo[n]; }
    guardarLocal(n);
    S.online = true; S.erro = null; S.ultimoSalvo = new Date();
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      const rem = await API.ler(caminhoCap(n)).catch(() => null);
      S.tentativas[n] = (S.tentativas[n] || 0) + 1;
      if (rem && rem.sha === base && S.tentativas[n] <= 3) {
        // O arquivo no GitHub é o mesmo de antes: o branch só estava ocupado. Tenta de novo, sem perguntar nada.
        setTimeout(() => enfileirar(n), 3e3);
      } else {
        delete S.tentativas[n];
        S.enviando--; atualizarSync();
        await resolverConflito(n, rem);
        S.enviando++;
      }
    } else if (e.offline) {
      S.online = false;
    } else {
      S.erro = msgErro(e);
    }
  } finally {
    S.enviando--; atualizarSync();
    if (!$('#gaveta').hidden) renderLista();
  }
}

function agendarProg() {
  clearTimeout(S.timers.prog);
  S.timers.prog = setTimeout(enviarProg, 15e3);
}
function mexerProg(n) {
  if (n != null) capProg(n).atualizado = Date.now();
  S.prog.dirty = true;
  LS.set('esc.prog', S.prog);
  agendarProg();
  atualizarSync();
}

async function enviarProg() {
  if (!S.prog.dirty || S.enviandoProg) return;
  clearTimeout(S.timers.prog);
  S.enviandoProg = true; S.enviando++; atualizarSync();
  try {
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      const foto = JSON.stringify(S.prog.doc);
      try {
        const sha = await API.gravar(CAMINHO_PROG, JSON.stringify(S.prog.doc, null, 1) + '\n', S.prog.sha, 'Progresso');
        S.prog.sha = sha;
        if (JSON.stringify(S.prog.doc) === foto) S.prog.dirty = false;
        S.online = true; S.erro = null; S.ultimoSalvo = new Date();
        break;
      } catch (e) {
        if (e.status === 409 || e.status === 422) {
          const rem = await API.ler(CAMINHO_PROG);
          if (rem) { S.prog.doc = mesclarProg(JSON.parse(rem.texto), S.prog.doc); S.prog.sha = rem.sha; } else S.prog.sha = null;
          continue;
        }
        if (e.offline) S.online = false; else S.erro = msgErro(e);
        break;
      }
    }
  } finally {
    LS.set('esc.prog', S.prog);
    S.enviandoProg = false; S.enviando--; atualizarSync();
  }
}

function enviarTudo() {
  const ps = [];
  for (const k in S.textos) if (S.textos[k].dirty) ps.push(enfileirar(+k));
  ps.push(enviarProg());
  return Promise.all(ps);
}

function salvarAgora() {
  if (S.atual && S.textos[S.atual]) { guardarLocal(S.atual); contarEAtualizar(S.atual); }
  S.erro = null;
  return enviarTudo();
}

function atualizarSync() {
  const b = $('#btn-sync'), txt = $('#sync-txt');
  let estado, rotulo, dica;
  if (S.conflito) { estado = 'conflito'; rotulo = 'conflito'; dica = 'Escolha qual versão manter.'; }
  else if (S.enviando > 0) { estado = 'salvando'; rotulo = 'salvando…'; dica = 'Enviando para o GitHub.'; }
  else if (S.erro) { estado = 'erro'; rotulo = 'erro ao salvar'; dica = S.erro + ' Clique para tentar de novo.'; }
  else if (pendente() && !S.online) { estado = 'offline'; rotulo = 'sem internet · salvo aqui'; dica = 'Sobe para o GitHub quando a internet voltar.'; }
  else if (pendente()) { estado = 'pendente'; rotulo = 'salvo aqui'; dica = 'Salvo neste computador. Sobe para o GitHub em alguns segundos (Ctrl+S envia agora).'; }
  else { estado = 'ok'; rotulo = 'salvo'; dica = S.ultimoSalvo ? 'No GitHub desde as ' + hora(S.ultimoSalvo) + '.' : 'Tudo no GitHub.'; }
  if (S.local && estado === 'ok') dica = 'Modo local: salvo só neste navegador.';
  b.dataset.estado = estado; txt.textContent = rotulo; b.title = dica;
}
$('#btn-sync').addEventListener('click', () => salvarAgora());

window.addEventListener('online', () => { S.online = true; enviarTudo(); });
setInterval(() => { if (pendente() && !S.conflito) enviarTudo(); }, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && S.atual && S.textos[S.atual] && !S.esquecendo) {
    guardarLocal(S.atual); guardarPos();
    if (pendente()) enviarTudo();
  }
});

/* ---------- novidades de outro computador ---------- */
let ultimaChecagem = 0;
async function atualizarDoGitHub({ forcar = false } = {}) {
  if (S.local || S.conflito) return;
  if (!forcar && Date.now() - ultimaChecagem < 15e3) return;
  ultimaChecagem = Date.now();
  let lista;
  try { lista = await API.listar('manuscrito'); }
  catch (e) { if (e.offline) { S.online = false; atualizarSync(); } return; }
  S.online = true;
  const arquivos = {};
  for (const f of lista) { const m = /^cap-(\d+)\.md$/.exec(f.name); if (m) arquivos[+m[1]] = f.sha; }
  S.arquivos = arquivos;
  const n = S.atual, t = S.textos[n];
  if (t && !t.dirty && (t.sha || null) !== (arquivos[n] || null) && arquivos[n]) {
    const rem = await API.ler(caminhoCap(n)).catch(() => null);
    if (rem && S.atual === n && !S.textos[n].dirty && rem.texto === S.textos[n].texto) {
      S.textos[n].sha = rem.sha; guardarLocal(n);
    } else if (rem && S.atual === n && !S.textos[n].dirty) {
      S.textos[n] = { texto: rem.texto, sha: rem.sha, dirty: false };
      guardarLocal(n);
      const pos = texto.selectionStart;
      texto.value = rem.texto; crescer(); renderContagem();
      texto.setSelectionRange(Math.min(pos, rem.texto.length), Math.min(pos, rem.texto.length));
      aviso('Este capítulo foi atualizado com o que você escreveu no outro computador.', 4500);
    }
  }
  if (!S.prog.dirty && !S.enviandoProg) {
    const rp = await API.ler(CAMINHO_PROG).catch(() => null);
    if (rp && rp.sha !== S.prog.sha && !S.prog.dirty) {
      S.prog = { doc: normalizarProg(JSON.parse(rp.texto)), sha: rp.sha, dirty: false };
      LS.set('esc.prog', S.prog);
      renderPainel(); renderContagem();
      if (!$('#gaveta').hidden) renderLista();
    }
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.dados) atualizarDoGitHub(); });
window.addEventListener('focus', () => { if (S.dados) atualizarDoGitHub(); });
setInterval(() => { if (document.visibilityState === 'visible' && S.dados && !pendente()) atualizarDoGitHub(); }, 120e3);

/* ---------- conflito ---------- */
function resolverConflito(n, rem) {
  const t = S.textos[n];
  if (!rem) { t.sha = null; t.dirty = true; guardarLocal(n); enfileirar(n); return Promise.resolve(); }
  if (rem.texto === t.texto) { t.sha = rem.sha; t.dirty = false; S.arquivos[n] = rem.sha; guardarLocal(n); return Promise.resolve(); }
  S.conflito = true; atualizarSync();
  const c = S.porN.get(n);
  const fim = s => { const p = s.trim().split(/\n+/).pop() || ''; return p.length > 220 ? '…' + p.slice(-220) : p; };
  return new Promise(resolve => {
    abrirDialogo({
      titulo: `Cap. ${n} mudou em outro computador`,
      sub: `${c.titulo}. As duas versões são diferentes. A que você não escolher continua guardada no histórico do GitHub.`,
      html: `<p><b>Neste computador</b> · ${fmtN(contarPalavras(t.texto))} palavras<br>${esc(fim(t.texto)) || '<i>(vazio)</i>'}</p>
             <p><b>No GitHub</b> · ${fmtN(contarPalavras(rem.texto))} palavras<br>${esc(fim(rem.texto)) || '<i>(vazio)</i>'}</p>`,
      travar: true,
      acoes: [
        { rotulo: 'Ficar com a do GitHub', fn: async () => {
          const copia = `manuscrito/conflitos/cap-${pad(n)}-${hoje()}-${Date.now()}.md`;
          try { await API.gravar(copia, t.texto, null, `Cópia do cap. ${n} feita num conflito`); } catch { /* fica no histórico local */ }
          Object.assign(t, { texto: rem.texto, sha: rem.sha, dirty: false });
          S.arquivos[n] = rem.sha; guardarLocal(n);
          if (S.atual === n) { texto.value = t.texto; crescer(); renderContagem(); }
        } },
        { rotulo: 'Ficar com a deste computador', primario: true, fn: async () => {
          Object.assign(t, { sha: rem.sha, dirty: true });
          S.arquivos[n] = rem.sha; guardarLocal(n);
        } },
      ],
      aoFechar: () => { S.conflito = false; atualizarSync(); if (t.dirty) enfileirar(n); resolve(); },
    });
  });
}

/* ============================== diálogo genérico ============================== */
function abrirDialogo({ titulo, sub = '', html = '', textoPuro = null, acoes = [], travar = false, aoFechar = null }) {
  const dlg = $('#dlg-ver');
  if (dlg.open && dlg.dataset.travado) return;
  if (dlg.open) dlg.close();
  dlg.dataset.travado = travar ? '1' : '';
  $('#ver-titulo').textContent = titulo;
  $('#ver-sub').textContent = sub; $('#ver-sub').hidden = !sub;
  const corpo = $('#ver-texto');
  corpo.classList.toggle('vazio', textoPuro === '');
  if (textoPuro !== null) corpo.textContent = textoPuro || 'Ainda não escrito.';
  else corpo.innerHTML = html;
  corpo.style.whiteSpace = textoPuro !== null ? 'pre-wrap' : 'normal';
  const caixa = $('#ver-acoes'); caixa.innerHTML = '';
  const lista = travar ? acoes : [...acoes, { rotulo: 'Fechar' }];
  for (const a of lista) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn' + (a.primario ? ' primario' : ''); b.textContent = a.rotulo;
    b.addEventListener('click', async () => { b.disabled = true; try { if (a.fn) await a.fn(); } finally { dlg.close(); } });
    caixa.appendChild(b);
  }
  dlg.oncancel = travar ? (e => e.preventDefault()) : null;
  dlg.onclose = () => { dlg.onclose = null; if (aoFechar) aoFechar(); };
  dlg.showModal();
  corpo.scrollTop = 0;
}

async function espiar(m) {
  const c = S.porN.get(m);
  let t = null;
  try { t = await carregarTexto(m); } catch (e) { aviso(msgErro(e)); return; }
  abrirDialogo({
    titulo: `Cap. ${m} · ${c.titulo}`,
    sub: c.resumo,
    textoPuro: (t?.texto || '').trim(),
    acoes: m === S.atual ? [] : [{ rotulo: 'Ir para este capítulo', primario: true, fn: () => abrir(m) }],
  });
}

/* ============================== painel ============================== */
const ABAS = ['roteiro', 'fios', 'biblia', 'notas', 'buscar', 'historico'];
$$('.abas [role="tab"]').forEach(b => b.addEventListener('click', () => trocarAba(b.id.slice(4))));
function trocarAba(aba) {
  S.aba = aba;
  for (const a of ABAS) {
    $('#tab-' + a).setAttribute('aria-selected', String(a === aba));
    $('#aba-' + a).hidden = a !== aba;
  }
  renderPainel();
}
function renderPainel() {
  if (!S.atual) return;
  ({ roteiro: renderRoteiro, fios: renderFios, biblia: renderBiblia, notas: renderNotas, buscar: renderBuscar, historico: renderHistorico })[S.aba]();
}

/* ---------- roteiro ---------- */
function avisosDe(c) { return c.avisos || []; }

function renderRoteiro() {
  const c = cap(), p = capProg(c.n), checks = new Set(p.checks || []);
  const marcaveis = c.blocos.map((b, i) => [b, i]).filter(([b]) => b.t === 'roteiro' || b.t === 'dialogo');
  const feitos = marcaveis.filter(([, i]) => checks.has(i)).length;
  const st = statusDe(c.n);
  const foco = c.foco.map((f, i) => c.focoRotulos?.[i] || nomeFoco(f)).join(' e ');
  const blocos = c.blocos.map((b, i) => {
    if (b.t === 'nota') return `<div class="nota">${esc(b.texto)}</div>`;
    if (b.t === 'marcador') return `<div class="marcador">${esc(b.texto)}</div>`;
    if (b.t === 'separador') return '<hr class="separador">';
    const feito = checks.has(i);
    const conteudo = b.t === 'dialogo'
      ? `<span class="beat-rot">diálogo de exemplo</span>${b.linhas.map(l => `<span class="fala">${esc(l)}</span>`).join('')}`
      : `<span>${esc(b.texto)}</span>`;
    return `<label class="beat${feito ? ' feito' : ''}"><input type="checkbox" data-i="${i}"${feito ? ' checked' : ''}><span class="beat-txt">${conteudo}</span></label>`;
  }).join('');
  $('#aba-roteiro').innerHTML = `
    <div class="ficha">
      <span class="quando">${(c.datas.length ? c.datas : [c.quando]).map(esc).join('<br>')}</span>
      <span>foco: ${esc(foco)}</span>
      <span>${esc(c.tempo)}</span>
      ${(c.etiquetas || []).map(e => `<span>${esc(e)}</span>`).join('')}
      <label class="sr" for="sel-status">Situação do capítulo</label>
      <select id="sel-status" class="sel-status">
        ${['vazio', 'rascunho', 'revisar', 'pronto'].map(v => `<option value="${v}"${v === st ? ' selected' : ''}>${STATUS_TXT[v]}</option>`).join('')}
      </select>
    </div>
    <ul class="avisos">${avisosDe(c).map(a => `<li>${esc(a)}</li>`).join('')}</ul>
    <p class="resumo">${esc(c.resumo)}</p>
    ${marcaveis.length ? `<p class="pontos-conta">${feitos} de ${marcaveis.length} pontos já escritos</p>` : ''}
    <div class="blocos">${blocos}</div>
    ${c.tituloDoc !== c.titulo ? `<p class="vazio-txt" style="margin-top:18px">Na linha temporal: “${esc(c.tituloDoc)}”.</p>` : ''}`;
}
$('#aba-roteiro').addEventListener('change', e => {
  if (e.target.id === 'sel-status') {
    capProg(S.atual).status = e.target.value;
    mexerProg(S.atual);
    if (!$('#gaveta').hidden) renderLista();
    return;
  }
  const cb = e.target.closest('input[data-i]');
  if (!cb) return;
  const p = capProg(S.atual), i = +cb.dataset.i;
  const set = new Set(p.checks || []);
  cb.checked ? set.add(i) : set.delete(i);
  p.checks = [...set].sort((a, b) => a - b);
  mexerProg(S.atual);
  renderRoteiro();
});

/* ---------- fios ---------- */
function renderFios() {
  const c = cap();
  if (!c.fios.length) {
    $('#aba-fios').innerHTML = `<p class="vazio-txt">Nenhum segredo ou pista marcado neste capítulo.</p>${linkMapa()}`;
    return;
  }
  $('#aba-fios').innerHTML = c.fios.map(f => `
    <div class="fio-bloco">
      <div class="fio-tipo">${f.tipo === 'segredo' ? `segredo · ${esc(nomeFoco(f.dono))}` : 'pista'}</div>
      <div class="fio-nome">${esc(f.nome)}</div>
      <p class="fio-aqui"><b>${K_AQUI[f.k]}:</b> ${esc(f.texto)}</p>
      <ol class="trajeto">${f.trajeto.map(q => `
        <li class="k-${q.k}${q.n === c.n ? ' aqui' : ''}">
          <span class="cap-n">cap. ${q.n}</span>
          ${q.n === c.n ? `<span>${esc(q.texto)}</span>` : `<button type="button" class="link" data-ir="${q.n}" title="${K_ROT[q.k]} · ${esc(S.porN.get(q.n).titulo)}">${esc(q.texto)}</button>`}
          ${q.n !== c.n && S.arquivos[q.n] ? `<button type="button" class="link ver" data-ver="${q.n}">ver texto</button>` : ''}
        </li>`).join('')}
      </ol>
    </div>`).join('') + linkMapa();
}
function linkMapa() { return S.dados.mapa ? `<p class="vazio-txt" style="margin-top:14px"><a href="${esc(S.dados.mapa)}" target="_blank" rel="noopener">Abrir o mapa visual da linha temporal ↗</a></p>` : ''; }
$('#aba-fios').addEventListener('click', e => {
  const ir = e.target.closest('[data-ir]'), ver = e.target.closest('[data-ver]');
  if (ir) abrir(+ir.dataset.ir);
  else if (ver) espiar(+ver.dataset.ver);
});

/* ---------- bíblia ---------- */
function renderBiblia() {
  const b = S.dados.biblia || {};
  const c = cap();
  const ordem = [...(b.personagens || [])].sort((x, y) => (c.foco.includes(y.id) ? 1 : 0) - (c.foco.includes(x.id) ? 1 : 0));
  const filtroAtual = $('#filtro-biblia')?.value || '';
  $('#aba-biblia').innerHTML = `
    <label class="sr" for="filtro-biblia">Filtrar a bíblia</label>
    <input id="filtro-biblia" class="filtro" type="search" placeholder="Filtrar: nome, lugar, detalhe…" value="${esc(filtroAtual)}">
    <h3>Personagens</h3>
    ${ordem.map(p => `
      <div class="pessoa item-biblia">
        <p class="pessoa-nome">${esc(p.nome)}</p>
        <p class="pessoa-papel">${esc(p.papel)}</p>
        <dl>
          ${p.fisico ? `<dt>Físico</dt><dd>${esc(p.fisico)}</dd>` : ''}
          ${p.jeito ? `<dt>Jeito</dt><dd>${esc(p.jeito)}</dd>` : ''}
          ${p.segredo ? `<dt>Segredo</dt><dd>${esc(p.segredo)}</dd>` : ''}
          ${p.fim ? `<dt>Fim</dt><dd>${esc(p.fim)}</dd>` : ''}
        </dl>
        ${p.detalhes?.length ? `<ul>${p.detalhes.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      </div>`).join('')}
    <h3>Lugares</h3>
    ${(b.lugares || []).map(l => `<p class="lugar item-biblia"><b>${esc(l.nome)}.</b> ${esc(l.texto)}</p>`).join('')}
    <h3>Cronologia</h3>
    <ul class="crono">${(b.cronologia || []).map(x => `<li class="item-biblia"><b>${esc(x.quando)}</b><span>${esc(x.texto)}</span></li>`).join('')}</ul>
    <h3>Regras do livro</h3>
    <ul class="regras">${(b.regras || []).map(r => `<li class="item-biblia">${esc(r.replace(/^💡\s*/, ''))}</li>`).join('')}</ul>`;
  aplicarFiltroBiblia();
}
function aplicarFiltroBiblia() {
  const q = dobrar(($('#filtro-biblia')?.value || '').trim());
  $$('#aba-biblia .item-biblia').forEach(el => { el.hidden = !!q && !dobrar(el.textContent).includes(q); });
}
$('#aba-biblia').addEventListener('input', e => { if (e.target.id === 'filtro-biblia') aplicarFiltroBiblia(); });

/* ---------- notas ---------- */
function renderNotas() {
  const c = cap(), p = capProg(c.n);
  const pends = S.prog.doc.pendencias.filter(x => !x.apagada)
    .sort((a, b) => (a.feito - b.feito) || (a.criado || 0) - (b.criado || 0));
  $('#aba-notas').innerHTML = `
    <h3>Notas deste capítulo</h3>
    <label class="sr" for="notas-cap">Notas do capítulo ${c.n}</label>
    <textarea id="notas-cap" class="notas-cap" placeholder="Ideias, dúvidas, frases soltas pra este capítulo…">${esc(p.notas || '')}</textarea>
    <h3>Pendências do livro</h3>
    <form class="form-pend" id="form-pend">
      <label class="sr" for="in-pend">Nova pendência</label>
      <input id="in-pend" type="text" placeholder="Ex.: voltar no cap. 3 e ajustar um detalhe" autocomplete="off">
      <button class="btn" type="submit">Adicionar</button>
    </form>
    <label class="chk-linha"><input type="checkbox" id="pend-ligar" checked> Ligar ao capítulo ${c.n}</label>
    ${pends.length ? `<ul class="pends">${pends.map(x => `
      <li class="pend${x.feito ? ' feito' : ''}" data-id="${esc(x.id)}">
        <input type="checkbox" aria-label="Feito"${x.feito ? ' checked' : ''}>
        <span><span class="pend-txt">${esc(x.texto)}</span>${x.cap ? `<button type="button" class="link pend-cap" data-ir="${x.cap}">cap. ${x.cap}</button>` : ''}</span>
        <button type="button" class="btn-icone" data-apagar aria-label="Apagar pendência"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
      </li>`).join('')}</ul>` : '<p class="vazio-txt">Nada pendente. Quando lembrar de algo pra corrigir em outro capítulo, anote aqui.</p>'}`;
}
$('#aba-notas').addEventListener('input', e => {
  if (e.target.id !== 'notas-cap') return;
  capProg(S.atual).notas = e.target.value;
  clearTimeout(S.timers.notas);
  S.timers.notas = setTimeout(() => mexerProg(S.atual), 500);
});
$('#aba-notas').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('#in-pend'), t = inp.value.trim();
  if (!t) return;
  S.prog.doc.pendencias.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), texto: t, cap: $('#pend-ligar').checked ? S.atual : null, feito: false, criado: Date.now(), atualizado: Date.now() });
  mexerProg(null); renderNotas(); $('#in-pend').focus();
});
$('#aba-notas').addEventListener('click', e => {
  const li = e.target.closest('.pend');
  if (e.target.closest('[data-ir]')) { abrir(+e.target.closest('[data-ir]').dataset.ir); return; }
  if (!li) return;
  const p = S.prog.doc.pendencias.find(x => x.id === li.dataset.id);
  if (!p) return;
  if (e.target.closest('[data-apagar]')) { p.apagada = true; p.atualizado = Date.now(); mexerProg(null); renderNotas(); }
  else if (e.target.matches('input[type="checkbox"]')) { p.feito = e.target.checked; p.atualizado = Date.now(); mexerProg(null); renderNotas(); }
});

/* ---------- buscar ---------- */
let ultimaBusca = { termo: '', roteiro: false, html: '' };
function renderBuscar() {
  $('#aba-buscar').innerHTML = `
    <form class="form-busca" id="form-busca">
      <label class="sr" for="in-busca">Buscar no livro</label>
      <input id="in-busca" type="search" placeholder="Buscar no que você já escreveu…" value="${esc(ultimaBusca.termo)}" autocomplete="off">
      <button class="btn" type="submit">Buscar</button>
    </form>
    <label class="chk-linha"><input type="checkbox" id="busca-roteiro"${ultimaBusca.roteiro ? ' checked' : ''}> Incluir o roteiro da linha temporal</label>
    <p class="busca-status" id="busca-status"></p>
    <div id="busca-res">${ultimaBusca.html}</div>`;
}

async function carregarTodos(aoProgresso) {
  const faltam = S.caps.map(c => c.n).filter(n => S.arquivos[n] && !(S.textos[n] && (S.textos[n].dirty || S.textos[n].sha === S.arquivos[n])));
  let feitos = 0;
  const fila = [...faltam];
  const trabalhador = async () => {
    while (fila.length) {
      const n = fila.shift();
      try { await carregarTexto(n); } catch { /* segue */ }
      feitos++; aoProgresso?.(feitos, faltam.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, faltam.length) }, trabalhador));
}

function trecho(original, i, len) {
  const ini = Math.max(0, i - 70), fim = Math.min(original.length, i + len + 90);
  return (ini > 0 ? '…' : '') + esc(original.slice(ini, i)) + '<mark>' + esc(original.slice(i, i + len)) + '</mark>' + esc(original.slice(i + len, fim)) + (fim < original.length ? '…' : '');
}

$('#aba-buscar').addEventListener('submit', async e => {
  e.preventDefault();
  const termo = $('#in-busca').value.trim();
  const incluirRoteiro = $('#busca-roteiro').checked;
  const status = $('#busca-status'), res = $('#busca-res');
  if (termo.length < 2) { status.textContent = 'Digite pelo menos 2 letras.'; return; }
  status.textContent = 'Carregando os capítulos…';
  await carregarTodos((f, t) => { status.textContent = `Carregando capítulos ${f} de ${t}…`; });
  const q = dobrar(termo);
  const achados = [];
  for (const c of S.caps) {
    const t = S.textos[c.n]?.texto || '';
    if (t) {
      const dob = dobrar(t);
      let i = dob.indexOf(q), k = 0;
      while (i !== -1 && k < 6) { achados.push({ n: c.n, i, len: termo.length, fonte: 'texto', html: trecho(t, i, termo.length) }); k++; i = dob.indexOf(q, i + q.length); }
    }
    if (incluirRoteiro) {
      const rt = c.blocos.map(b => b.texto || (b.linhas || []).join(' ')).filter(Boolean).join(' ');
      const i = dobrar(rt).indexOf(q);
      if (i !== -1) achados.push({ n: c.n, fonte: 'roteiro', html: trecho(rt, i, termo.length) });
    }
  }
  status.textContent = achados.length ? `${achados.length} resultado${achados.length > 1 ? 's' : ''}` : 'Nada encontrado.';
  res.innerHTML = achados.slice(0, 250).map(a => `
    <button type="button" class="res" data-n="${a.n}"${a.fonte === 'texto' ? ` data-i="${a.i}" data-len="${a.len}"` : ' data-roteiro'}>
      <span class="res-cab">Cap. ${a.n} · ${esc(S.porN.get(a.n).titulo)}<small>${a.fonte === 'texto' ? 'no texto' : 'no roteiro'}</small></span>${a.html}
    </button>`).join('');
  ultimaBusca = { termo, roteiro: incluirRoteiro, html: res.innerHTML };
});
$('#aba-buscar').addEventListener('click', e => {
  const r = e.target.closest('.res');
  if (!r) return;
  const n = +r.dataset.n;
  if (r.hasAttribute('data-roteiro')) { abrir(n).then(() => trocarAba('roteiro')); return; }
  const i = +r.dataset.i, len = +r.dataset.len;
  abrir(n, { selecionar: [i, i + len] });
});

/* ---------- histórico ---------- */
async function renderHistorico() {
  const el = $('#aba-historico'), n = S.atual;
  if (S.local) { el.innerHTML = '<p class="vazio-txt">O histórico aparece quando o app está conectado ao GitHub.</p>'; return; }
  if (!S.arquivos[n]) { el.innerHTML = '<p class="vazio-txt">Este capítulo ainda não tem versões salvas no GitHub.</p>'; return; }
  el.innerHTML = '<p class="vazio-txt">Carregando versões…</p>';
  let commits;
  try { commits = await API.historico(caminhoCap(n)); }
  catch (e) { if (S.atual === n && S.aba === 'historico') el.innerHTML = `<p class="vazio-txt">${esc(msgErro(e))}</p>`; return; }
  if (S.atual !== n || S.aba !== 'historico') return;
  el.innerHTML = `<p class="vazio-txt" style="margin-bottom:8px">Cada salvamento vira uma versão. Clique numa delas pra ver e, se quiser, restaurar.</p>` +
    commits.map(cm => {
      const d = new Date(cm.commit.author?.date || cm.commit.committer?.date);
      const msg = cm.commit.message.split('\n')[0];
      const pal = /\((\d+) palavras\)/.exec(msg)?.[1];
      return `<button type="button" class="versao" data-sha="${esc(cm.sha)}" data-quando="${esc(d.toLocaleString('pt-BR'))}">
        <b>${esc(d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }))} às ${hora(d)}</b><small>${pal ? fmtN(+pal) + ' palavras' : ''}</small>
        <small style="grid-column:1/-1">${esc(msg)}</small></button>`;
    }).join('');
}
$('#aba-historico').addEventListener('click', async e => {
  const v = e.target.closest('.versao');
  if (!v) return;
  const n = S.atual;
  let r;
  try { r = await API.ler(caminhoCap(n), v.dataset.sha); } catch (err) { aviso(msgErro(err)); return; }
  abrirDialogo({
    titulo: `Versão de ${v.dataset.quando}`,
    sub: `Cap. ${n} · ${S.porN.get(n).titulo} · ${fmtN(contarPalavras(r?.texto || ''))} palavras`,
    textoPuro: (r?.texto || '').trim(),
    acoes: [{ rotulo: 'Restaurar esta versão', primario: true, fn: () => {
      if (S.atual !== n) return;
      texto.focus();
      texto.select();
      ajustando = true;
      try { inserir(r?.texto || ''); } finally { ajustando = false; }
      aviso('Versão restaurada. A versão anterior continua no histórico.');
    } }],
  });
});

/* ============================== gaveta ============================== */
function renderLista() {
  const q = dobrar($('#in-ir').value.trim());
  let html = '', parte = 0;
  for (const c of S.caps) {
    if (q && !(String(c.n) === q || dobrar(c.titulo).includes(q))) continue;
    if (c.parte !== parte) { parte = c.parte; html += `<div class="lista-parte">${esc(S.dados.partes[parte])}</div>`; }
    const st = statusDe(c.n), w = palavrasDe(c.n);
    const local = S.textos[c.n]?.dirty;
    html += `<button type="button" class="item-cap${c.n === S.atual ? ' atual' : ''}" data-n="${c.n}"${c.n === S.atual ? ' aria-current="true"' : ''}>
      <span class="n">${c.n}</span><span class="t">${esc(c.titulo)}</span>
      <span class="w">${w ? fmtN(w) : ''}${local ? '<span class="pend-local" title="Ainda não enviado"> •</span>' : ''}</span>
      <span class="st st-${st}" title="${STATUS_TXT[st]}"></span></button>`;
  }
  $('#lista-caps').innerHTML = html || '<p class="vazio-txt" style="padding:16px">Nenhum capítulo com esse nome.</p>';
  const total = S.caps.reduce((s, c) => s + palavrasDe(c.n), 0);
  const prontos = S.caps.filter(c => statusDe(c.n) === 'pronto').length;
  const comecados = S.caps.filter(c => statusDe(c.n) !== 'vazio').length;
  const meta = S.prog.doc.config.metaDiaria || 0, dia = palavrasDoDia(hoje()), seq = sequencia();
  $('#gaveta-rodape').innerHTML = `
    <div><b>${fmtN(total)}</b> palavras no livro · <b>${comecados}</b> começados · <b>${prontos}</b>/${S.caps.length} prontos</div>
    <div>Hoje: <b>${fmtN(dia)}</b>${meta ? ` de ${fmtN(meta)} palavras` : ' palavras'}</div>
    ${seq > 1 ? `<div>${seq} dias seguidos escrevendo</div>` : ''}
    <div class="legenda"><span><span class="st"></span>não começado</span><span><span class="st st-rascunho"></span>rascunho</span><span><span class="st st-revisar"></span>revisar</span><span><span class="st st-pronto"></span>pronto</span></div>`;
}
function abrirGaveta() {
  renderLista();
  $('#gaveta').hidden = false; $('#gaveta-fundo').hidden = false;
  $('#in-ir').value = ''; renderLista();
  setTimeout(() => { $('#in-ir').focus(); $('.item-cap.atual')?.scrollIntoView({ block: 'center' }); }, 20);
}
function fecharGaveta() { $('#gaveta').hidden = true; $('#gaveta-fundo').hidden = true; }
$('#btn-caps').addEventListener('click', abrirGaveta);
$('#gaveta-fundo').addEventListener('click', fecharGaveta);
$('#lista-caps').addEventListener('click', e => { const b = e.target.closest('.item-cap'); if (b) { fecharGaveta(); abrir(+b.dataset.n); } });
$('#in-ir').addEventListener('input', renderLista);
$('#in-ir').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); const b = $('.item-cap', $('#lista-caps')); if (b) { fecharGaveta(); abrir(+b.dataset.n); } }
});

/* ============================== barra e atalhos ============================== */
$('#btn-ant').addEventListener('click', () => abrir(S.atual - 1));
$('#btn-prox').addEventListener('click', () => abrir(S.atual + 1));
function alternarPainel(forcar) {
  if (ehEstreito()) { painelMobile(forcar ?? !$('#painel').classList.contains('aberto')); return; }
  S.prefs.painel = forcar ?? !S.prefs.painel;
  salvarPrefs();
  if (!S.prefs.painel) texto.focus({ preventScroll: true });
}
function painelMobile(abrirPainel) {
  $('#painel').classList.toggle('aberto', abrirPainel);
  $('#btn-painel').setAttribute('aria-pressed', String(abrirPainel));
}
$('#btn-painel').addEventListener('click', () => alternarPainel());
$('#btn-fechar-painel').addEventListener('click', () => painelMobile(false));

/* a moldura (barras) some enquanto se escreve e volta ao mexer o mouse */
const temMouse = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
let ultimoMouse = null;
texto.addEventListener('input', () => { if (temMouse) document.body.classList.add('digitando'); });
document.addEventListener('mousemove', e => {
  if (ultimoMouse && Math.abs(e.clientX - ultimoMouse[0]) + Math.abs(e.clientY - ultimoMouse[1]) > 6) document.body.classList.remove('digitando');
  ultimoMouse = [e.clientX, e.clientY];
});

document.addEventListener('keydown', e => {
  if ($('#tela-app').hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); salvarAgora(); }
  else if (mod && k === 'k') { e.preventDefault(); $('#gaveta').hidden ? abrirGaveta() : fecharGaveta(); }
  else if (mod && e.key === '.') { e.preventDefault(); alternarPainel(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); if (S.atual > 1) abrir(S.atual - 1); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); if (S.atual < S.caps.length) abrir(S.atual + 1); }
  else if (e.key === 'Escape' && !$('#dlg-ver').open && !$('#dlg-config').open) {
    if (!$('#gaveta').hidden) fecharGaveta();
    else if ($('#painel').classList.contains('aberto')) painelMobile(false);
  }
});

/* ============================== configurações ============================== */
function aplicarPrefs() {
  document.documentElement.style.setProperty('--fonte', S.prefs.fonte + 'px');
  if (S.prefs.tema === 'noite') document.documentElement.dataset.theme = 'noite';
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = S.prefs.tema === 'noite' ? '#1E1B17' : '#F4EDDD';
  document.body.classList.toggle('sem-painel', !S.prefs.painel);
  $('#btn-painel')?.setAttribute('aria-pressed', String(!!S.prefs.painel));
}
function salvarPrefs() { LS.set('esc.prefs', S.prefs); aplicarPrefs(); if (!$('#tela-app').hidden) crescer(); }

$('#btn-config').addEventListener('click', () => {
  $('#cfg-travessao').checked = S.prefs.travessao;
  $('#cfg-aspas').checked = S.prefs.aspas;
  $('#cfg-reticencias').checked = S.prefs.reticencias;
  $('#cfg-fonte').value = S.prefs.fonte; $('#cfg-fonte-out').textContent = S.prefs.fonte + 'px';
  $('#cfg-meta').value = S.prog.doc.config.metaDiaria ?? 500;
  $('#cfg-tema').value = S.prefs.tema;
  $('#cfg-conexao').textContent = S.local ? 'Modo local (sem GitHub).' : `${S.cfg.repo} · branch ${S.cfg.branch}`;
  $('#dlg-config').showModal();
});
$('#cfg-travessao').addEventListener('change', e => { S.prefs.travessao = e.target.checked; salvarPrefs(); });
$('#cfg-aspas').addEventListener('change', e => { S.prefs.aspas = e.target.checked; salvarPrefs(); });
$('#cfg-reticencias').addEventListener('change', e => { S.prefs.reticencias = e.target.checked; salvarPrefs(); });
$('#cfg-fonte').addEventListener('input', e => { S.prefs.fonte = +e.target.value; $('#cfg-fonte-out').textContent = S.prefs.fonte + 'px'; salvarPrefs(); });
$('#cfg-tema').addEventListener('change', e => { S.prefs.tema = e.target.value; salvarPrefs(); });
$('#cfg-meta').addEventListener('change', e => {
  S.prog.doc.config = { ...S.prog.doc.config, metaDiaria: Math.max(0, +e.target.value || 0), atualizado: Date.now() };
  mexerProg(null); renderContagem();
});

$('#btn-trocar-token').addEventListener('click', () => {
  $('#dlg-config').close();
  S.cfg = { ...S.cfg, token: '' };
  mostrarConectar();
});

$('#btn-esquecer').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (pendente() && !b.dataset.confirmar) {
    b.textContent = 'Enviando o que falta…';
    await salvarAgora();
    if (pendente()) { b.dataset.confirmar = '1'; b.textContent = 'Há texto não enviado. Clique de novo pra apagar mesmo assim'; return; }
  }
  S.esquecendo = true;
  for (const k in S.timers) clearTimeout(S.timers[k]);
  for (const k of LS.keys('esc.')) LS.del(k);
  location.replace(location.pathname);
});

async function exportar(formato) {
  aviso('Juntando os capítulos…', 10000);
  try { await carregarTodos(); } catch { /* usa o que tiver */ }
  const titulo = S.dados.livro || 'Livro';
  let out = formato === 'md' ? `# ${titulo}\n\n` : `${titulo.toUpperCase()}\n\n`;
  let parte = 0;
  for (const c of S.caps) {
    if (c.parte !== parte) {
      parte = c.parte;
      out += formato === 'md' ? `\n## ${S.dados.partes[parte]}\n\n` : `\n\n${S.dados.partes[parte].toUpperCase()}\n\n`;
    }
    const t = (S.textos[c.n]?.texto || '').trim();
    if (formato === 'md') {
      out += `### Capítulo ${c.n}\n<!-- ${c.titulo} -->\n\n`;
      out += t ? t.split(/\n+/).map(p => p.trim()).filter(Boolean).join('\n\n') + '\n\n' : '_(ainda não escrito)_\n\n';
    } else {
      out += `Capítulo ${c.n}\n\n${t || '(ainda não escrito)'}\n\n`;
    }
  }
  const nome = (titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'livro') + `-${hoje()}.${formato}`;
  const url = URL.createObjectURL(new Blob([out], { type: (formato === 'md' ? 'text/markdown' : 'text/plain') + ';charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  aviso('Arquivo baixado: ' + nome);
}
$('#btn-exportar-md').addEventListener('click', () => exportar('md'));
$('#btn-exportar-txt').addEventListener('click', () => exportar('txt'));

/* ============================== início ============================== */
window.addEventListener('resize', () => { if (!$('#tela-app').hidden) crescer(); });
iniciar();
})();
