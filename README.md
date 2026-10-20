# quality-flare

Continuous Integration rodando inteiramente na Cloudflare, entregue como uma GitHub App. Cada check vira um check run na pull request.

Toda a infraestrutura é Cloudflare: um único Worker, um namespace KV com as configurações de cada repositório e o Cloudflare Access protegendo o admin. O projeto foi criado e é publicado com o novo CLI da Cloudflare, [`cf`](https://www.npmjs.com/package/cf). Para rodar o seu, veja [Instale o seu](#instale-o-seu).

## Checks

| Check | O que faz |
| --- | --- |
| [Closes an issue](src/checks/closes-issue) | Exige que a PR feche uma issue |
| [Tests](src/checks/tests) | Roda os testes do repositório num Dynamic Worker |
| [Container tests](src/checks/tests/container.ts) | Roda o vitest do próprio repositório num container e, se configurados, outros comandos (typecheck, lint…), cada um com seu check run |
| [Dependabot auto-merge](src/checks/dependabot-automerge) | Habilita auto-merge (squash) nas PRs do Dependabot |
| [Codex review](src/checks/codex-review) | Exige que as sugestões do Codex (`chatgpt-codex-connector`) estejam resolvidas |

Para adicionar um check, implemente a interface `Check` de [`src/checks/types.ts`](src/checks/types.ts) e registre em [`src/checks/index.ts`](src/checks/index.ts).

### Closes an issue

- ✅ Passa se a PR fecha pelo menos uma issue: palavra-chave na descrição (`Closes #12`, `fixes owner/repo#3`, `Resolves https://github.com/o/r/issues/7`) ou issue vinculada na seção **Development** da barra lateral.
- ✅ Passa se a PR tem a label `no-issue`.
- ⏭️ Pula (conta como aprovado) PRs que não miram a branch padrão, PRs em rascunho (a não ser que tenham a label `run-ci`) e PRs do `dependabot[bot]`.
- ❌ Falha em qualquer outro caso, com instruções de como corrigir.

### Tests

Roda os testes do repositório no commit `head` da PR, dentro de um [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) criado na hora, com o runner e o `expect` do Vitest (`@vitest/runner` + `@vitest/expect`), sem o Vitest em si.

A convenção, sem configuração por repositório:

- **Quais arquivos:** todo `*.test.{ts,mts,js,mjs}` e `*.spec.{ts,mts,js,mjs}`, fora de `node_modules`, `dist`, `build`, `coverage` e pastas ocultas.
- **API:** importe de `"vitest"` como sempre: `describe`, `it`/`test`, hooks (`beforeEach`…), `expect` (matchers do Jest, `expect.objectContaining`, `expect.assertions`…) e `vi` (`vi.fn`, `vi.spyOn`, `vi.stubGlobal`, `vi.unstubAllGlobals`, `vi.restoreAllMocks`). `vi.mock` e fake timers ainda não existem.
- **Imports:** TypeScript é convertido na hora; `./a`, `./a.js` e `./a/index.ts` encontram `a.ts`, como num bundler. Pacotes do npm vêm do lockfile (`pnpm-lock.yaml` ou `package-lock.json`), na versão exata, baixados do registry. `paths` do `tsconfig.json` e pacotes do workspace (npm/pnpm) também resolvem. Specs do Playwright (`@playwright/test`) ficam de fora. Módulos do Node (`node:crypto`, `crypto`…) funcionam com `nodejs_compat`.
- **Ambiente:** o runtime dos Workers, sem rede (`fetch` só funciona se o teste fizer stub), com limite de 120 s de CPU e 5 minutos de relógio por lote. Os arquivos rodam em lotes, um Dynamic Worker por lote, até 2 em paralelo; cada lote junta até 30 arquivos que importam o mesmo código, até uns 32 MB pelo que cada arquivo carregou na última execução (arquivo nunca medido conta como 6,4 MB), distribuídos pela Cloudflare Queue `quality-flare-tests`; um lote grande demais (mais de 48 MB de código) ou que derruba o Worker se divide ao meio até caber.
- ✅ Passa se todos os testes passam; ⚪ neutro se o repositório não tem testes; ❌ falha com cada teste que falhou e a mensagem do `expect`.
- Roda quando a PR é aberta, reaberta, recebe commits ou sai de draft (não em mudanças de label ou descrição), e no **Re-run**.

Um teste que só funciona no Node pode se pular no Workers com `describe.skipIf(navigator.userAgent === "Cloudflare-Workers")`.

### Container tests

Roda o vitest do próprio repositório, com a config dele, num [container](https://developers.cloudflare.com/containers/) criado para cada execução (imagem em [`containers/tests`](containers/tests), Node 24, instância `standard-4`: 4 vCPU, 12 GiB). Serve para o que não roda no Dynamic Worker: testes que precisam de processos, sockets, `vm`, módulos nativos ou do typecheck. É um check separado do **Tests**: os dois são ligados um a um no admin, e um repositório pode usar os dois (por exemplo, testes de unidade baratos no Tests e o resto aqui).

- **Passos:** clona o commit da PR, com o histórico da branch base em `origin/<base>`, usando um token que só lê aquele repositório, e faz o merge da base nele, como o GitHub Actions faz em `pull_request` (com conflito, o check falha pedindo para resolver); instala as dependências pelo lockfile (`npm ci`, `pnpm install --frozen-lockfile` ou `yarn install --frozen-lockfile`, sem scripts de instalação); roda `vitest run`; depois roda cada comando da config, na ordem.
- **Config:** a seção `container` do `quality-flare.json`, separada da seção `tests` do check Tests. Quando a PR não tem o arquivo, vale o da branch base:

  ```json
  {
    "tests": { "include": ["src/**/*.test.ts"] },
    "container": {
      "vitestArgs": ["--config", "vitest.unit.config.mts"],
      "install": "npm ci",
      "commands": {
        "Typecheck": "npm run typecheck",
        "Lint": "npm run lint"
      }
    }
  }
  ```

  `vitestArgs` vai para o `vitest run`; `install` troca o comando de instalação; cada entrada de `commands` (até 8) roda depois dos testes e aparece como um check run com aquele nome. Os comandos rodam com `CI=true`, `GITHUB_BASE_REF` e `GITHUB_SHA`, como no GitHub Actions. `"typecheck": "…"` é um atalho para um comando **Typecheck**, que roda primeiro. `"cache": ["node_modules/.cache/eslint", "tsconfig.tsbuildinfo"]` guarda esses caminhos da execução diária completa para as execuções das PRs do mesmo repositório (no R2, um por combinação de lockfile, `package.json`, `install` e lista de caminhos; as PRs só leem, para o código delas não deixar um cache que dê por verificado o que ninguém verificou), para ferramentas que pulam o que não mudou, como `eslint --cache --cache-strategy content` e o `tsc` incremental. Cada caminho fica abaixo da raiz e fora da `.git`; um caminho com arquivos versionados, ou com um symlink nele, acima ou abaixo dele, não é restaurado. Com `install` próprio ou quando a instalação não é reaproveitável (abaixo), o cache fica desligado, como o snapshot. `"snapshot": true` faz a execução diária completa da branch padrão (só existe com `"changed": true`) guardar um [snapshot](https://developers.cloudflare.com/containers/guides/snapshots/) do container logo depois de instalar as dependências, antes de rodar qualquer outro código do repositório; as execuções das PRs começam dele, com o clone e o `node_modules` prontos, e pulam a instalação enquanto o lockfile, os `package.json`, a config do gerenciador de pacotes (`.npmrc`, `pnpm-workspace.yaml`…) e o `install` forem os mesmos. Só a branch padrão grava o snapshot porque a instalação roda como root e o snapshot guarda o sistema de arquivos inteiro: o código de uma PR poderia deixar qualquer coisa nele para as execuções seguintes. A instalação só é reaproveitada (pulada, no snapshot ou no cache) com npm e `package-lock.json`, com cada pacote dele fixado por `integrity` ou como link para uma pasta do repositório ([`qf-reusable.mjs`](containers/tests/qf-reusable.mjs)): sem isso, o que vai para o `node_modules` pode mudar sem mudar os arquivos da chave (um pacote local empacotado com `install-links`, uma dependência git, um pnpmfile, a config do Yarn, pacotes injetados do pnpm). Com `install` próprio o snapshot fica desligado, porque um script de instalação pode mudar sem mudar os arquivos que dizem se dá para pular a instalação.
- **Enquanto roda:** a cada 10 s, o check run **Container tests** mostra quantos testes já passaram e as falhas assim que aparecem (vitest 3 ou mais novo), e o de cada comando mostra o final do log até ali. Cada comando completa o seu check run assim que termina, sem esperar os testes. A página da execução no admin mostra o mesmo, ao vivo.
- **Limites:** clone 5 min, instalação 10 min, testes 15 min, cada comando 15 min; o container é destruído ao terminar, num push novo na PR ou após 20 min.
- **Custo:** memória e disco pelo tempo ligado, CPU pelo que foi usado; uns US$ 0,02 por execução no Tudo Macaé (instalação + 3477 testes + typecheck em ~4 min). A página da execução no admin mostra o custo estimado.
- ✅ Passa se todos os testes passam; ⚪ neutro se o vitest não encontra testes; ❌ falha com cada teste que falhou, ou com o log do passo que falhou.

### Testes sob demanda

Uma opção por repositório no admin, desligada por padrão, que vale para o **Tests** e o **Container tests**. Ligada, um push na PR não roda esses checks: cada um fica em espera até alguém com acesso ao repositório (OWNER, MEMBER ou COLLABORATOR) comentar `/quality-flare run` na PR. O comentário roda o commit atual uma vez e recebe um 🚀; o próximo push volta a esperar. Se o commit já tem uma execução rodando, o comentário não começa outra e recebe um 👀. Com o check **Codex review** ligado, o comentário também não roda nada enquanto o Codex ainda revisa a PR ou deixou sugestões sem resolver, e recebe um 😕. Sair de draft ou reabrir a PR no mesmo commit não muda nada: o commit fica com o check run que já tem. O **Re-run** também roda.

Um push cujo único commit novo é um merge limpo da base não volta a esperar: se o commit anterior da PR passou, se o commit juntado está na base e se o merge só traz arquivos da base exatamente como lá, sem nenhum arquivo que a PR também mudou, o commit novo herda os check runs verdes do anterior (título `Reaproveitado de <commit>`). Qualquer outro caso (um arquivo mudado dos dois lados, uma mudança própria no merge, um merge de outro branch, um commit anterior que não passou) espera outro `/quality-flare run`. Um conflito que a base traz em outro arquivo, como um export renomeado que a PR usa, passa por aqui; a run diária na base pega.

O check em espera termina como **Action required** (`action_required`), com o título `Aguardando "/quality-flare run"`. Ele trava o merge como uma falha, mas termina a check suite: um check `queued` nunca terminava, e agentes que esperam o CI acabar ficavam parados sem nunca acordar.

A ideia é que agentes rodem os testes localmente o tempo todo e só peçam a execução remota no fim: depois de abrir a PR, corrigir as reviews e deixá-la pronta para o merge, sem push depois que a suíte fica verde. O texto do check em espera diz isso ao agente. Como agentes que acompanham a PR só veem o check como pendente, o quality-flare também mantém **um único comentário de status** na PR e o edita a cada mudança, sem criar outro. O comentário diz o commit e o estado de cada check:

| Situação | O comentário diz |
| --- | --- |
| Push numa PR pronta (ou ela sai de draft) e os checks ficam esperando | ⏳ esperando `/quality-flare run`; é aqui que o comentário nasce |
| Push depois de uma execução (rodando, verde ou vermelha) | ⏳ esperando, e que a execução no commit anterior não vale para o novo |
| O Codex está revisando ou deixou sugestões sem resolver, com os checks esperando | ⏸️ esperando o Codex review, com o motivo |
| `/quality-flare run` enquanto o Codex bloqueia | ⏸️ esperando o Codex review, e que o comando não rodou nada |
| O Codex review libera (conversas resolvidas, review terminou) | ⏳ esperando `/quality-flare run` |
| `/quality-flare run` ou **Re-run** começa a execução, ou o commit já tinha uma rodando | 🏃 rodando |
| A execução termina (webhook `check_run` `completed` do Tests ou do Container tests) | ✅ passaram ou ❌ falharam, check por check |

Drafts não ganham o comentário, mas um comentário que já existe continua sendo atualizado. O estado vem dos check runs do quality-flare no commit, e o comentário só é editado quando o texto muda. Um check em espera que a branch exige trava o merge, inclusive o auto-merge, até alguém pedir a execução. PRs abertas por bots, como as do Dependabot, rodam direto em todo push.

### Dependabot auto-merge

Faz o mesmo que o workflow `gh pr merge --auto --squash` para PRs do Dependabot, sem GitHub Actions.

- ✅ Numa PR aberta por `dependabot[bot]`, habilita o auto-merge com squash (GraphQL `enablePullRequestAutoMerge`). A PR é mergeada quando os checks exigidos passarem.
- ⚪ Neutro em PRs de outros autores, e numa PR do Dependabot que já pode ser mergeada: o GitHub só aceita auto-merge enquanto há checks exigidos pendentes. Quando a branch base muda, o Dependabot faz rebase e o check tenta de novo.
- ❌ Falha se o GitHub recusar, com a mensagem e como corrigir (por exemplo, auto-merge desligado no repositório).
- Roda quando a PR é aberta, reaberta, recebe commits ou sai de draft, e no **Re-run**.
- Requisitos: **Allow auto-merge** ligado em Settings → General do repositório, e a App com Contents e Pull requests em **Read and write**. Para o auto-merge esperar algo, o repositório precisa exigir pelo menos um check na proteção de branch.

### Codex review

Garante que as reviews do [Codex](https://chatgpt.com/codex) (`chatgpt-codex-connector[bot]`) foram tratadas antes do merge.

- ❌ Falha enquanto houver alguma conversa aberta pelo Codex sem **Resolve conversation**, inclusive as que ficaram desatualizadas porque o código mudou. O resumo lista cada sugestão com a prioridade (P0, P1…) e o link.
- 🟡 Fica pendente (check run em andamento) enquanto o Codex está revisando: o comentário "Codex Review Summary" mostra uma review em andamento, ou (sem esse comentário) o Codex reagiu com 👀 na PR.
- ✅ Passa quando o Codex revisou e todas as conversas dele estão resolvidas, ou quando ele não deixou sugestões.
- ⚪ Neutro enquanto o Codex não revisou a PR.
- Roda nos eventos de PR, a cada review, comentário de review, conversa resolvida ou reaberta e comentário na PR (o Codex edita o resumo quando termina), e no **Re-run**.

## Como funciona

1. O GitHub envia o webhook para o Worker; a assinatura `X-Hub-Signature-256` é verificada.
2. O Worker assina um JWT da App (RS256, WebCrypto) e troca por um token da instalação.
3. Lê as issues que a PR fecha via GraphQL (`closingIssuesReferences`) e também procura palavras-chave na descrição.
4. Responde ao GitHub na hora e continua em `waitUntil`: roda cada check registrado e cria um check run por check no commit `head` da PR. O Tests só lista os arquivos de teste, abre o check run como "em andamento" e coloca os lotes na fila; o mesmo Worker consome a fila, e o último lote a terminar completa o check run.
5. O check Tests baixa o tarball do commit, monta os módulos (testes, código importado e pacotes do npm) e carrega tudo num Dynamic Worker pelo binding `LOADER`. O runtime de testes ([`src/checks/tests/runtime`](src/checks/tests/runtime)) é empacotado no build por [`build/test-runtime.ts`](build/test-runtime.ts).

Eventos tratados:

| Evento | Ações |
| --- | --- |
| `pull_request` | `opened`, `reopened`, `edited`, `synchronize`, `labeled`, `unlabeled`, `ready_for_review` |
| `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | todas (só os checks que pedem esses eventos, como o Codex review) |
| `issue_comment` | todas, em PRs (idem) |
| `check_run` | `rerequested` (botão **Re-run**; roda só aquele check), `completed` (Tests e Container tests do próprio App: atualiza o comentário de status) |
| `check_suite` | `rerequested` (roda todos os checks) |

Vincular uma issue pela barra lateral não gera webhook. Depois de vincular, clique em **Re-run** no check (ou edite a descrição) para reavaliar.

## Instale o seu

Qualquer pessoa pode rodar o próprio quality-flare, na própria conta Cloudflare e com a própria GitHub App. Não precisa instalar nada no computador: o build roda no [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

**Precisa de:** uma conta Cloudflare no plano **Workers Paid** (US$ 5/mês; Containers e Dynamic Workers não existem no plano grátis) e uma conta GitHub.

1. **Faça um fork** deste repositório.
2. **Conecte o fork à Cloudflare:** em [Workers & Pages → Create → Import a repository](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create), escolha o fork e use:
   - **Nome do Worker** (Project name): `quality-flare`, o mesmo do `cloudflare.config.ts`
   - **Build command:** `pnpm typecheck && pnpm test`
   - **Deploy command:** `pnpm run deploy`

   O primeiro deploy cria sozinho o KV, o D1, o bucket R2 e a Queue. O Worker sobe ainda sem GitHub App: até ela existir, ele recusa webhooks e manda quem abre o endereço para `/setup`.
3. **Abra `https://quality-flare.<seu-subdomínio>.workers.dev/setup`.** A página mostra o que falta e faz o resto com você:
   - **Criar a GitHub App:** um clique cria a App no GitHub (na sua conta ou numa organização) com as permissões, os eventos e o webhook certos. Na volta, a página mostra o `GITHUB_APP_ID`, o `GITHUB_WEBHOOK_SECRET` e o `GITHUB_PRIVATE_KEY` uma única vez; adicione os três como **Secret** em Settings → Build → Variables and secrets do Worker.
   - **`PUBLIC_URL`:** a página mostra o valor (o próprio endereço, ou o seu domínio); adicione como variável de build.
   - **Login do admin:** crie uma aplicação self-hosted do Cloudflare Access para `/admin` e `/admin/*` com uma política que permita o seu e-mail, e copie o AUD para a variável de build `ACCESS_AUD`. Até lá o admin fica fechado.

   Depois de mudar variáveis ou secrets de build, rode o build de novo (**Deployments → Retry build**, ou um push na `main`).
4. **Instale a App** nos repositórios (o link aparece em `/setup` e no admin) e **ative-os** em `/admin`. Tudo começa desligado.

Cada push na `main` do fork publica de novo. O `pnpm run deploy` ([`scripts/deploy.mjs`](scripts/deploy.mjs)) é o `cf deploy` que também envia os secrets da App guardados no build; sem eles, é o `cf deploy` puro.

Opcional:

- **Cache do Container tests:** o bucket R2 `quality-flare-turbo-cache` guarda o cache das execuções. Para ele não crescer para sempre, apague o que tem mais de 14 dias: `cf r2 buckets lifecycle update quality-flare-turbo-cache -f --rules '[{"id":"expire-14-days","enabled":true,"conditions":{"prefix":""},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":1209600}}}]'`.
- **Uso real da conta no admin** ([`/admin/costs`](#admin)): crie um API token com *Account Analytics: Read*, guarde-o no Secrets Store como `quality-flare-analytics-token` e defina as variáveis de build `SECRETS_STORE_ID` e `CLOUDFLARE_ACCOUNT_ID`. Sem elas, a página mostra só as estimativas.
- **Domínio próprio:** adicione um Custom Domain ao Worker, use-o em `PUBLIC_URL`, na aplicação do Access e na Webhook URL da App.

### Variáveis de build

Ficam em Settings → Build → Variables and secrets do Worker; o [`cloudflare.config.ts`](cloudflare.config.ts) lê os IDs da conta e dos recursos delas, para que não fiquem no repositório. Todas são opcionais para o deploy, e `/setup` diz quais ainda faltam.

| Variável | O que é | Sem ela |
| --- | --- | --- |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Secrets da GitHub App, criados em `/setup` | O Worker recusa webhooks e espera a App |
| `PUBLIC_URL` | Endereço onde se abre o admin (links dos check runs; o container usa para o cache) | Links quebrados |
| `ACCESS_AUD` | Audience (AUD) da aplicação do Cloudflare Access que protege `/admin` | Admin fechado |
| `SETTINGS_KV_ID` | ID do KV com as configurações | O deploy cria um, ou mantém o que o Worker já usa |
| `RUNS_D1_ID` | ID do D1 com o histórico | O deploy usa (ou cria) o D1 `quality-flare-runs` |
| `SECRETS_STORE_ID`, `CLOUDFLARE_ACCOUNT_ID` | Secrets Store do token `quality-flare-analytics-token` e conta cujo uso o admin mostra | `/admin/costs` só com estimativas |

Fora do Workers Builds (`cf dev`, `pnpm typecheck`, testes), o que faltar vira um valor de exemplo.

### Instância oficial

A instância do projeto, em [`https://quality-flare.frega.dev`](https://quality-flare.frega.dev), é publicada do mesmo jeito, a partir deste repositório, com o deploy command `pnpm exec cf deploy`: os secrets da App ficam no próprio Worker, e as variáveis de build trazem os IDs dos recursos que já existiam.

- A app **Cloudflare Workers and Pages** precisa ter acesso ao repositório no GitHub (Settings → Applications → Configure → Repository access). Sem isso, a Cloudflare não recebe os pushes e nenhum build é disparado.
- Não altere o código do Worker direto pela API ou pelo painel da Cloudflare. O `cf deploy` em CI se recusa a publicar quando o Worker foi modificado fora dele; nesse caso, um deploy único com `wrangler deploy` destrava.

### Publicar do seu computador

Precisa do Docker (para a imagem do container):

```sh
pnpm install
cp .dev.vars.example .dev.vars   # os secrets da App, para o cf dev
pnpm exec cf auth login          # ou CLOUDFLARE_API_TOKEN
pnpm run deploy                  # com as variáveis acima no ambiente, se tiver
```

### Exigir os checks

Em cada repositório: **Settings → Rules** (ou Branch protection) → exigir os status checks que devem travar o merge, como **Closes an issue**.

### Permissões da GitHub App

A App criada em `/setup` já vem assim; para criar à mão, em **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL:** o endereço do Worker; **Webhook secret:** um valor aleatório, o mesmo de `GITHUB_WEBHOOK_SECRET`.
- **Permissões do repositório:** Checks, Contents, Pull requests e Issues em **Read and write** (o Tests baixa o código da PR; o Dependabot auto-merge mergeia; o comentário de status vai na PR; a execução diária abre uma issue quando falha); Metadata **Read-only**.
- **Eventos:** Pull request, Check run, Check suite, Pull request review, Pull request review comment, Pull request review thread, Issue comment.

## Admin

Em [`/admin`](https://quality-flare.frega.dev/admin) ficam os repositórios onde a App está instalada. Tudo começa desativado:

- O interruptor **Ativar checks** de cada repositório liga o quality-flare nele. Enquanto estiver desligado, o Worker ignora os webhooks desse repositório e não cria check runs.
- Clicar no repositório abre a lista dos checks, cada um com seu interruptor, e os botões **Ativar todos** e **Desativar todos**.
- Num repositório ativo, um check desativado não roda e é publicado com conclusão `neutral` ("Desativado"), para que um check exigido pela proteção de branch não trave o merge.
- **Execuções de testes** ([`/admin/runs`](https://quality-flare.frega.dev/admin/runs)) lista as 50 execuções mais recentes do check Tests: rodando, passou, falhou, neutro ou interrompida (ficou "rodando" por mais de 30 minutos). As páginas acompanham ao vivo: cada teste aparece assim que termina, com a contagem ("12 de 40 · 1 falhou"). Cada execução abre com os arquivos, cada teste e a mensagem de cada falha.
- **Custos** ([`/admin/costs`](https://quality-flare.frega.dev/admin/costs)) mostra o uso medido da conta Cloudflare no mês e por dia (Dynamic Workers, CPU, erros; GraphQL Analytics com o token `quality-flare-analytics-token` do Secrets Store) e a estimativa por execução, repositório, dia e mês. A estimativa vem da tabela `test_shard_attempts` do D1: cada entrega de lote da fila registra arquivos, tamanho do código, resultado, tempo e se criou um Dynamic Worker; o Tail Worker `ShardTail` acrescenta o CPU do Dynamic Worker e se ele caiu por memória. Os Container tests entram nas duas partes: o uso real traz memória, CPU e disco dos containers da conta (`containersUsageAdaptiveGroups`) contra a franquia do mês, e a estimativa soma a tabela `test_container_runs` (tempo ligado e CPU de cada container). A lista e a página de cada execução mostram os Dynamic Workers, as quedas e o custo estimado, inclusive o do container.

- **Login:** uma aplicação self-hosted do Cloudflare Access cobre `/admin` e `/admin/*` em `quality-flare.frega.dev` e no endereço `workers.dev` do Worker. O Worker ainda confere `ctx.access` e exige que o `aud` seja o dessa aplicação (`ACCESS_AUD`), então o admin recusa qualquer pedido que não passou pelo Access.
- **Ao vivo:** o Dynamic Worker transmite cada teste que termina (NDJSON) para o check, que repassa em lotes ao Durable Object `RunsHub` (binding `LIVE`). As páginas do admin abrem um WebSocket em `/admin/live` (atrás do Access, só da mesma origem) e recebem os eventos; quem abre no meio de uma execução recebe o progresso até ali. Sem JavaScript, a página recarrega a cada 5 s.
- **Histórico de testes:** D1 `quality-flare-runs` (binding `RUNS`), tabela `test_runs`, criada pelo próprio Worker no primeiro uso (não há migração para rodar).
- **Armazenamento:** o KV do binding `SETTINGS`, chave `repo:<owner/repo>` com `{ "enabled": true, "enabledChecks": ["closes-issue"] }`.

Cada check tem um `id` estável (por exemplo `closes-issue`) que é o que fica salvo; não mude o `id` de um check já publicado.

## Configuração opcional

Em `cloudflare.config.ts`:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `NO_ISSUE_LABEL` | `no-issue` | Label que dispensa a issue |

## Desenvolvimento

```sh
pnpm test        # testes (Vitest)
pnpm typecheck   # tipos do Worker + tsc
cf dev           # servidor local
```
