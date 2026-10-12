# quality-flare

Continuous Integration rodando inteiramente na Cloudflare, entregue como uma GitHub App. Cada check vira um check run na pull request.

Toda a infraestrutura é Cloudflare: por enquanto um único Worker, sem estado (não usa KV nem D1). O projeto foi criado e é publicado com o novo CLI da Cloudflare, [`cf`](https://www.npmjs.com/package/cf).

## Checks

| Check | O que faz |
| --- | --- |
| [Closes an issue](src/checks/closes-issue) | Exige que a PR feche uma issue |

Para adicionar um check, implemente a interface `Check` de [`src/checks/types.ts`](src/checks/types.ts) e registre em [`src/checks/index.ts`](src/checks/index.ts).

### Closes an issue

- ✅ Passa se a PR fecha pelo menos uma issue: palavra-chave na descrição (`Closes #12`, `fixes owner/repo#3`, `Resolves https://github.com/o/r/issues/7`) ou issue vinculada na seção **Development** da barra lateral.
- ✅ Passa se a PR tem a label `no-issue`.
- ❌ Falha em qualquer outro caso, com instruções de como corrigir.

## Como funciona

1. O GitHub envia o webhook para o Worker; a assinatura `X-Hub-Signature-256` é verificada.
2. O Worker assina um JWT da App (RS256, WebCrypto) e troca por um token da instalação.
3. Lê as issues que a PR fecha via GraphQL (`closingIssuesReferences`) e também procura palavras-chave na descrição.
4. Roda cada check registrado e cria um check run por check no commit `head` da PR.

Eventos tratados:

| Evento | Ações |
| --- | --- |
| `pull_request` | `opened`, `reopened`, `edited`, `synchronize`, `labeled`, `unlabeled`, `ready_for_review` |
| `check_run` | `rerequested` (botão **Re-run**; roda só aquele check) |
| `check_suite` | `rerequested` (roda todos os checks) |

Vincular uma issue pela barra lateral não gera webhook. Depois de vincular, clique em **Re-run** no check (ou edite a descrição) para reavaliar.

## Configuração

### 1. Publicar o Worker

```sh
pnpm add --global cf
pnpm install
cp .dev.vars.example .dev.vars   # preencha depois de criar a App (passo 2)
export CLOUDFLARE_API_TOKEN=...  # token com permissão "Workers Scripts: Edit"
cf deploy --secrets-file .dev.vars
```

A URL publicada (`https://quality-flare.<subdomínio>.workers.dev`) é a URL do webhook.

### 2. Criar a GitHub App

Em **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL:** a URL do Worker.
- **Webhook secret:** um valor aleatório; o mesmo vai em `GITHUB_WEBHOOK_SECRET`.
- **Permissões do repositório:**
  - Checks: **Read and write**
  - Pull requests: **Read-only**
  - Issues: **Read-only**
  - Metadata: **Read-only**
- **Eventos:** Pull request, Check run, Check suite.

Depois de criar, anote o **App ID**, gere uma **private key** e instale a App nos repositórios desejados. Coloque os três valores no `.dev.vars` e rode `cf deploy --secrets-file .dev.vars` de novo.

### 3. Exigir o check

Em cada repositório: **Settings → Rules** (ou Branch protection) → exigir o status check **Closes an issue**.

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
