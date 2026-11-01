# Escrivaninha

Editor de livro em uma página só. Mostra o roteiro de cada capítulo ao lado do texto e salva tudo num repositório **privado** do GitHub do autor.

Esta página não guarda conteúdo nenhum. Ela lê e salva no repositório usando um token que o autor cola no próprio navegador. Sem esse token, o app só mostra a tela de conexão.

O repositório conectado precisa ter `dados/capitulos.json` (o roteiro). O texto vai para `manuscrito/cap-NN.md` e o progresso para `manuscrito/progresso.json`.

Para testar sem GitHub, sirva a pasta pai e abra `app/index.html?local`.
