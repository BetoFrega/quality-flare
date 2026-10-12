# quality-flare

Continuous Integration rodando inteiramente na Cloudflare, entregue como uma GitHub App. Cada check vira um check run na pull request.

Toda a infraestrutura é Cloudflare: um único Worker, um namespace KV com as configurações de cada repositório e o Cloudflare Access protegendo o admin. O projeto foi criado e é publicado com o novo CLI da Cloudflare, [`cf`](https://www.npmjs.com/package/cf).

## Checks

| Check | O que faz |
| --- | --- |
| [Closes an issue](src/checks/closes-issue) | Exige que a PR feche uma issue |
| [Tests](src/checks/tests) | Roda os testes do repositório num Dynamic Worker |

Para adicionar um check, implemente a interface `Check` de [`src/checks/types.ts`](src/checks/types.ts) e registre em [`src/checks/index.ts`](src/checks/index.ts).

### Closes an issue

- ✅ Passa se a PR fecha pelo menos uma issue: palavra-chave na descrição (`Closes #12`, `fixes owner/repo#3`, `Resolves https://github.com/o/r/issues/7`) ou issue vinculada na seção **Development** da barra lateral.
- ✅ Passa se a PR tem a label `no-issue`.
- ❌ Falha em qualquer outro caso, com instruções de como corrigir.

### Tests

Roda os testes do repositório no commit `head` da PR, dentro de um [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) criado na hora, com o runner e o `expect` do Vitest (`@vitest/runner` + `@vitest/expect`), sem o Vitest em si.

A convenção, sem configuração por repositório:

- **Quais arquivos:** todo `*.test.{ts,mts,js,mjs}` e `*.spec.{ts,mts,js,mjs}`, fora de `node_modules`, `dist`, `build`, `coverage` e pastas ocultas.
- **API:** importe de `"vitest"` como sempre: `describe`, `it`/`test`, hooks (`beforeEach`…), `expect` (matchers do Jest, `expect.objectContaining`, `expect.assertions`…) e `vi` (`vi.fn`, `vi.spyOn`, `vi.stubGlobal`, `vi.unstubAllGlobals`, `vi.restoreAllMocks`). `vi.mock` e fake timers ainda não existem.
- **Imports:** TypeScript é convertido na hora; `./a`, `./a.js` e `./a/index.ts` encontram `a.ts`, como num bundler. Pacotes do npm vêm do lockfile (`pnpm-lock.yaml` ou `package-lock.json`), na versão exata, baixados do registry. Módulos do Node (`node:crypto`, `crypto`…) funcionam com `nodejs_compat`.
- **Ambiente:** o runtime dos Workers, sem rede (`fetch` só funciona se o teste fizer stub), com limite de 30 s de CPU.
- ✅ Passa se todos os testes passam; ⚪ neutro se o repositório não tem testes; ❌ falha com cada teste que falhou e a mensagem do `expect`.
- Roda quando a PR é aberta, reaberta, recebe commits ou sai de draft (não em mudanças de label ou descrição), e no **Re-run**.

Um teste que só funciona no Node pode se pular no Workers com `describe.skipIf(navigator.userAgent === "Cloudflare-Workers")`.

## Como funciona

1. O GitHub envia o webhook para o Worker; a assinatura `X-Hub-Signature-256` é verificada.
2. O Worker assina um JWT da App (RS256, WebCrypto) e troca por um token da instalação.
3. Lê as issues que a PR fecha via GraphQL (`closingIssuesReferences`) e também procura palavras-chave na descrição.
4. Responde ao GitHub na hora e continua em `waitUntil`: roda cada check registrado e cria um check run por check no commit `head` da PR.
5. O check Tests baixa o tarball do commit, monta os módulos (testes, código importado e pacotes do npm) e carrega tudo num Dynamic Worker pelo binding `LOADER`. O runtime de testes ([`src/checks/tests/runtime`](src/checks/tests/runtime)) é empacotado no build por [`build/test-runtime.ts`](build/test-runtime.ts).

Eventos tratados:

| Evento | Ações |
| --- | --- |
| `pull_request` | `opened`, `reopened`, `edited`, `synchronize`, `labeled`, `unlabeled`, `ready_for_review` |
| `check_run` | `rerequested` (botão **Re-run**; roda só aquele check) |
| `check_suite` | `rerequested` (roda todos os checks) |

Vincular uma issue pela barra lateral não gera webhook. Depois de vincular, clique em **Re-run** no check (ou edite a descrição) para reavaliar.

## Configuração

### 1. Publicar o Worker

O deploy é automático: o Worker está conectado a este repositório pelo [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), e cada push na `main` roda `pnpm typecheck && pnpm test` e depois `pnpm exec cf deploy`. Pushes em outras branches não publicam.

Requisitos para o deploy automático funcionar:

- A app **Cloudflare Workers and Pages** precisa ter acesso a este repositório no GitHub (Settings → Applications → Configure → Repository access). Sem isso, a Cloudflare não recebe os pushes e nenhum build é disparado.
- Não altere o código do Worker direto pela API ou pelo painel da Cloudflare. O `cf deploy` em CI se recusa a publicar quando o Worker foi modificado fora dele; nesse caso, um deploy único com `wrangler deploy` destrava.

Para publicar manualmente:

```sh
pnpm add --global cf
pnpm install
cp .dev.vars.example .dev.vars   # preencha depois de criar a App (passo 2)
export CLOUDFLARE_API_TOKEN=...  # token com permissão "Workers Scripts: Edit"
cf deploy --secrets-file .dev.vars
```

A URL publicada (`https://quality-flare.<subdomínio>.workers.dev`) é a URL do webhook. Os secrets (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) ficam no Worker e são mantidos entre deploys.

### 2. Criar a GitHub App

Em **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL:** a URL do Worker.
- **Webhook secret:** um valor aleatório; o mesmo vai em `GITHUB_WEBHOOK_SECRET`.
- **Permissões do repositório:**
  - Checks: **Read and write**
  - Contents: **Read-only** (o check Tests baixa o código da PR)
  - Pull requests: **Read-only**
  - Issues: **Read-only**
  - Metadata: **Read-only**
- **Eventos:** Pull request, Check run, Check suite.

Depois de criar, anote o **App ID**, gere uma **private key** e instale a App nos repositórios desejados. Coloque os três valores no `.dev.vars` e rode `cf deploy --secrets-file .dev.vars` de novo.

### 3. Exigir o check

Em cada repositório: **Settings → Rules** (ou Branch protection) → exigir o status check **Closes an issue**.

## Admin

Em [`/admin`](https://quality-flare.frega.workers.dev/admin) ficam os repositórios onde a App está instalada. Tudo começa desativado:

- O interruptor **Ativar checks** de cada repositório liga o quality-flare nele. Enquanto estiver desligado, o Worker ignora os webhooks desse repositório e não cria check runs.
- Clicar no repositório abre a lista dos checks, cada um com seu interruptor, e os botões **Ativar todos** e **Desativar todos**.
- Num repositório ativo, um check desativado não roda e é publicado com conclusão `neutral` ("Desativado"), para que um check exigido pela proteção de branch não trave o merge.
- **Execuções de testes** ([`/admin/runs`](https://quality-flare.frega.workers.dev/admin/runs)) lista as 50 execuções mais recentes do check Tests: rodando, passou, falhou, neutro ou interrompida (ficou "rodando" por mais de 2 minutos, o Worker passou do tempo). A lista se atualiza sozinha enquanto há testes rodando. Cada execução abre com os arquivos, cada teste e a mensagem de cada falha.

- **Login:** uma aplicação self-hosted do Cloudflare Access cobre `quality-flare.frega.workers.dev/admin` e `/admin/*`. O Worker ainda confere `ctx.access` e exige que o `aud` seja o dessa aplicação (`ACCESS_AUD`), então o admin recusa qualquer pedido que não passou pelo Access.
- **Histórico de testes:** D1 `quality-flare-runs` (binding `RUNS`), tabela `test_runs`, criada pelo próprio Worker no primeiro uso (não há migração para rodar).
- **Armazenamento:** KV `quality-flare-settings` (binding `SETTINGS`), chave `repo:<owner/repo>` com `{ "enabled": true, "enabledChecks": ["closes-issue"] }`.

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
