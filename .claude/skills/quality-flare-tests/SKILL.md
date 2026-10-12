---
name: quality-flare-tests
description: Como preparar a suíte de testes de um repositório para rodar no check "Tests" do quality-flare (Dynamic Worker com @vitest/runner + @vitest/expect), o que funciona, o que não funciona e como depurar uma falha.
---

# Rodar uma suíte de testes no quality-flare

O check **Tests** do quality-flare baixa o commit `head` da PR, monta os módulos e roda os testes num [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) (runtime dos Workers, `nodejs_compat`), usando `@vitest/runner` e `@vitest/expect`, sem o Vitest em si. Não há arquivo de configuração: o check segue a convenção abaixo. O código está em [`src/checks/tests/`](../../../src/checks/tests).

## Ligar o check

1. A GitHub App do quality-flare precisa da permissão **Contents: Read-only** (é por ela que o código é baixado) e estar instalada no repositório.
2. No admin (`https://quality-flare.frega.workers.dev/admin`), ative o repositório e o check **Tests**. Todo check começa desligado; um check desligado aparece como `neutral` ("Desativado").
3. Opcional: exija o status check **Tests** na proteção de branch.

O check roda quando a PR é aberta, reaberta, recebe commits ou sai de draft, e no botão **Re-run**. Mudar label ou descrição não roda os testes de novo.

## Convenção

- **Arquivos de teste:** todo `*.test.{ts,mts,js,mjs}` e `*.spec.{ts,mts,js,mjs}` do repositório, fora de `node_modules/`, `dist/`, `build/`, `coverage/` e de qualquer pasta que comece com `.`. `.tsx`/`.jsx` e `.cjs` não são testes.
- **API de teste:** importe de `"vitest"`, como já se faz:
  - `describe`/`suite`, `it`/`test` (com `.skip`, `.only`, `.todo`, `.each`, `.skipIf`, `.runIf`, `.concurrent`), `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `onTestFailed`, `onTestFinished`.
  - `expect` com os matchers do Jest/Vitest (`toBe`, `toEqual`, `toMatchObject`, `toThrow`, `resolves`/`rejects`, `toHaveBeenCalledWith`…), os assimétricos (`expect.objectContaining`, `expect.any`, `expect.stringContaining`…), `expect.assertions`, `expect.hasAssertions`, `expect.soft`, `expect.extend`, `expect.unreachable`.
  - `vi.fn`, `vi.spyOn`, `vi.mocked`, `vi.isMockFunction`, `vi.clearAllMocks`/`resetAllMocks`/`restoreAllMocks`, `vi.stubGlobal`, `vi.unstubAllGlobals`.
- **TypeScript:** os tipos são removidos na hora (sucrase), sem checagem de tipos. Imports usados só como tipo somem, como no `tsc`. `enum` e parameter properties funcionam; decorators não.
- **Imports relativos:** resolvidos como num bundler. `./a`, `./a.js`, `./a.ts` e `./a/index.ts` encontram `a.ts`. Arquivos `.json` podem ser importados. `package.json#imports` (`#alias`) funciona. Os `paths` do `tsconfig.json` (`"@/*": ["./src/*"]`) também: vale o `tsconfig.json` mais próximo acima do arquivo que declare `paths`, sem seguir `extends`.
- **Pacotes do npm:** vêm do lockfile na raiz do repositório, `pnpm-lock.yaml` (v9) ou `package-lock.json` (v2/v3), na versão exata, baixados de `registry.npmjs.org`. Pacotes com mais de 8 MB de código (como o `next`) não ficam inteiros na memória: só os arquivos que os testes alcançam são lidos, numa nova leitura do tarball. Em monorepo pnpm, cada pasta de `importers` usa as próprias dependências. Pacotes do próprio workspace (npm/pnpm workspaces, `link:`) são carregados direto do repositório, pelo `exports`/`main` do `package.json` deles, e podem apontar para `.ts`. Entre as condições de `exports`, `workerd`/`worker`/`import`/`node` têm preferência sobre `require`. Imports nomeados de pacotes CommonJS funcionam quando os nomes aparecem de forma estática (`exports.x =`, `module.exports = { x }`, saída do esbuild/tsc).
- **Node:** `node:crypto`, `node:buffer`, `node:events` etc. (e também sem o prefixo `node:`) funcionam com o que o `nodejs_compat` do Workers oferece.

## Configuração

Sem configuração, vale a convenção acima. Um `quality-flare.json` na raiz do repositório espelha o config do Vitest que a suíte usa:

```json
{
  "tests": {
    "include": ["src/**/*.test.{ts,tsx}", "bin/**/*.test.ts"],
    "exclude": ["**/*.integration.test.{ts,tsx}", "**/*.runtime.test.ts"],
    "setupFiles": ["vitest.setup.ts"],
    "globals": true,
    "testTimeout": 20000
  }
}
```

- **`include`/`exclude`:** globs como os do Vitest (`**`, `*`, `?`, `{a,b}`), relativos à raiz. Com `include`, a convenção `*.test.*` deixa de valer. `node_modules` sempre fica de fora.
- **`setupFiles`:** rodam antes dos arquivos de teste, uma vez por Dynamic Worker (não uma vez por arquivo, como no Vitest com isolamento).
- **`globals`:** `describe`, `it`, `test`, `expect`, `vi`, `beforeEach` e os demais hooks ficam globais.

## Limitações

- **Sem rede:** o Dynamic Worker roda com `globalOutbound: null`. Qualquer `fetch` real falha; faça stub com `vi.stubGlobal("fetch", vi.fn(...))`.
- **Sem `vi.mock`/`vi.doMock`** (não existe grafo de módulos para interceptar) e **sem fake timers** (`vi.useFakeTimers`). Os dois lançam erro explicando isso. Prefira injeção de dependência ou `vi.spyOn` num objeto.
- **Sem snapshots** (`toMatchSnapshot`, `toMatchInlineSnapshot`) e sem `expect.poll`.
- **Playwright fica de fora:** `*.spec.ts` que importa `@playwright/test` não é rodado. Specs que só importam fixtures locais do Playwright ainda são pegos; mova-os para uma pasta ignorada ou renomeie.
- **Lotes:** os arquivos de teste rodam em lotes de 20, cada lote num Dynamic Worker próprio, só com o código que aqueles arquivos importam. Os lotes passam por uma Cloudflare Queue (`quality-flare-tests`) e rodam em paralelo. Um lote que passa de 48 MB de código, ou cujo Worker cai, se divide ao meio até caber ou até isolar o arquivo culpado. Um arquivo sozinho com mais de 64 MB de imports (Next.js inteiro, por exemplo) aparece como falha com o tamanho.
- **Sem arquivo de config do Vitest:** `vitest.config.*` não é lido; aliases do Vite e `environment` (jsdom/happy-dom) são ignorados. `include`, `exclude`, `setupFiles`, `globals` e `testTimeout` vêm do `quality-flare.json` (veja Configuração).
- **Runtime do Workers, não o Node:** não há sistema de arquivos real, nem `child_process`, nem processos; `Date.now()` só avança em I/O. APIs do Node que o `nodejs_compat` não implementa falham.
- **Pacotes:** só os que estão no lockfile e no registry público do npm. Sem lockfile, ou com yarn/bun, só imports relativos e `vitest` funcionam. Registries privados e dependências git não são resolvidos. Pacotes que precisam de binário nativo ou de WebAssembly compilado em runtime não funcionam.
- **Limites:** 30 s de CPU por lote no Dynamic Worker e 128 MB de memória no Worker que monta o lote. Um lote que derruba o Worker três vezes é reportado como falha.
- Os testes de todos os arquivos rodam no mesmo isolate, um arquivo depois do outro. Estado global vaza entre arquivos: limpe stubs em `afterEach` (`vi.unstubAllGlobals()`, `vi.restoreAllMocks()`).

## Teste que só funciona no Node

Pule no Workers e mantenha no Node:

```ts
const inWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";

describe.skipIf(inWorkers)("integração com o sistema de arquivos", () => {
	it("lê um arquivo", async () => {
		const { readFile } = await import("node:fs/promises"); // import dinâmico: só carrega se rodar
		// ...
	});
});
```

Use import dinâmico dentro do teste para módulos que não existem no Workers ou que não estão no lockfile. Import estático de um módulo que não resolve derruba o arquivo inteiro.

## Ler uma falha

Cada execução fica registrada em **Execuções de testes** no admin (`/admin/runs`). Enquanto roda, a página mostra ao vivo cada teste que termina; depois, o resultado com cada arquivo, cada teste e a mensagem de cada falha. Uma execução que fica "rodando" por mais de 30 minutos aparece como interrompida; use **Re-run** na PR.

O check run mostra uma tabela por arquivo e uma seção por falha:

- **Teste que falhou:** nome completo (`suite › teste`), arquivo e a mensagem do `expect`, com diff.
- **Arquivo quebrado** (erro fora de um teste): o import falhou ou um `beforeAll`/`afterAll` lançou erro. Erros como `does not provide an export named 'x'` vindos de `/__qf/missing/<nome>.js` querem dizer que aquele import não foi resolvido. A seção **Imports não resolvidos** lista cada um, com o arquivo de origem.
- **"Nenhum teste encontrado"** (neutro): nenhum arquivo segue a convenção.
- **"Não foi possível rodar os testes"**: o download ou a montagem falhou antes de rodar. Um 403/404 ao baixar o código de um repositório privado quer dizer que falta a permissão Contents: Read-only na App, ou que a instalação ainda não aceitou essa permissão.

## Reproduzir localmente

A suíte de testes do próprio quality-flare tem um teste que sobe o `workerd` com um binding de Worker Loader e roda um repositório de exemplo do mesmo jeito que o check: [`test/checks/tests/dynamic-worker.test.ts`](../../../test/checks/tests/dynamic-worker.test.ts). Para rodar a suíte de outro repositório localmente, adapte o `runInWorkerd` desse arquivo: monte o mapa `caminho → conteúdo` com `buildModules` e chame o host.
