---
name: quality-flare-tests
description: Como preparar a suíte de testes de um repositório para rodar no check "Tests" do quality-flare (Dynamic Worker com @vitest/runner + @vitest/expect), o que funciona, o que não funciona e como depurar uma falha.
---

# Rodar uma suíte de testes no quality-flare

O check **Tests** do quality-flare baixa o commit `head` da PR, monta os módulos e roda os testes num [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) (runtime dos Workers, `nodejs_compat`), usando `@vitest/runner` e `@vitest/expect`, sem o Vitest em si. O check segue o config do Vitest do repositório e, sem ele, a convenção abaixo. O código está em [`src/checks/tests/`](../../../src/checks/tests).

## Ligar o check

1. A GitHub App do quality-flare precisa da permissão **Contents: Read-only** (é por ela que o código é baixado) e estar instalada no repositório.
2. No admin (`https://quality-flare.frega.workers.dev/admin`), ative o repositório e o check **Tests**. Todo check começa desligado; um check desligado aparece como `neutral` ("Desativado").
3. Opcional: exija o status check **Tests** na proteção de branch.

O check roda quando a PR é aberta, reaberta, recebe commits ou sai de draft, e no botão **Re-run**. Mudar label ou descrição não roda os testes de novo. Uma execução nova cancela a anterior da mesma PR que ainda estiver rodando: o check run antigo termina como `cancelled` e os lotes dela que ainda estão na fila são descartados.

## Convenção

- **Arquivos de teste:** todo `*.test.{ts,mts,tsx,js,mjs,jsx}` e `*.spec.{…}` do repositório, fora de `node_modules/`, `dist/`, `build/`, `coverage/` e de qualquer pasta que comece com `.`.
- **API de teste:** importe de `"vitest"`, como já se faz:
  - `describe`/`suite`, `it`/`test` (com `.skip`, `.only`, `.todo`, `.each`, `.skipIf`, `.runIf`, `.concurrent`), `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `onTestFailed`, `onTestFinished`.
  - `expect` com os matchers do Jest/Vitest (`toBe`, `toEqual`, `toMatchObject`, `toThrow`, `resolves`/`rejects`, `toHaveBeenCalledWith`…), os assimétricos (`expect.objectContaining`, `expect.any`, `expect.stringContaining`…), `expect.assertions`, `expect.hasAssertions`, `expect.soft`, `expect.extend`, `expect.unreachable`.
  - `vi.fn`, `vi.spyOn`, `vi.mocked`, `vi.isMockFunction`, `vi.clearAllMocks`/`resetAllMocks`/`restoreAllMocks`, `vi.stubGlobal`/`unstubAllGlobals`, `vi.stubEnv`/`unstubAllEnvs`, `vi.waitFor`/`waitUntil`.
  - `vi.mock(caminho, factory)` e `vi.hoisted` no topo do arquivo, com `importOriginal` e `vi.importActual(caminho literal)`. Cada arquivo vê só os próprios mocks, inclusive em módulos importados indiretamente. A factory pode usar imports do arquivo e `const x = vi.fn(…)` declarados no topo, como no Vitest. `vi.stubGlobal`/`vi.stubEnv` no topo do arquivo valem só para os testes dele.
  - Fake timers do Vitest: `vi.useFakeTimers`, `advanceTimersByTime(Async)`, `runAllTimers(Async)`, `runOnlyPendingTimers`, `getTimerCount`, `setSystemTime`, `useRealTimers`.
- **Ambiente:** `node` por padrão. `// @vitest-environment jsdom` (ou `happy-dom`) no arquivo, ou `environment` no config, instala os globais do DOM durante o arquivo; o pacote vem do lockfile. Os arquivos de um lote com o mesmo ambiente compartilham a janela, porque os pacotes guardam o `document` que viram primeiro (o `screen` do Testing Library, por exemplo); antes dos testes de cada arquivo, `head`, `body` e `localStorage`/`sessionStorage` são esvaziados.
- **TypeScript e JSX:** os tipos são removidos na hora (sucrase), sem checagem de tipos; JSX usa o runtime automático do React (`react/jsx-runtime`). Imports de CSS são vazios e CSS modules devolvem o nome da classe. Imports usados só como tipo somem, como no `tsc`. `enum` e parameter properties funcionam; decorators não.
- **Imports relativos:** resolvidos como num bundler. `./a`, `./a.js`, `./a.ts` e `./a/index.ts` encontram `a.ts`. Arquivos `.json` podem ser importados. `package.json#imports` (`#alias`) funciona. Os `paths` do `tsconfig.json` (`"@/*": ["./src/*"]`) também: vale o `tsconfig.json` mais próximo acima do arquivo que declare `paths`, sem seguir `extends`.
- **Pacotes do npm:** vêm do lockfile na raiz do repositório, `pnpm-lock.yaml` (v9) ou `package-lock.json` (v2/v3), na versão exata, baixados de `registry.npmjs.org`. Pacotes com mais de 8 MB de código (como o `next`) não ficam inteiros na memória: só os arquivos que os testes alcançam são lidos, numa nova leitura do tarball. Em monorepo pnpm, cada pasta de `importers` usa as próprias dependências. Pacotes do próprio workspace (npm/pnpm workspaces, `link:`) são carregados direto do repositório, pelo `exports`/`main` do `package.json` deles, e podem apontar para `.ts`. Entre as condições de `exports`, `workerd`/`worker`/`import`/`node` têm preferência sobre `require`. Imports nomeados de pacotes CommonJS funcionam quando os nomes aparecem de forma estática (`exports.x =`, `module.exports = { x }`, saída do esbuild/tsc).
- **Node:** `node:crypto`, `node:buffer`, `node:events` etc. (e também sem o prefixo `node:`) funcionam com o que o `nodejs_compat` do Workers oferece.

## Configuração

O check lê o config do Vitest do repositório sem executá-lo: o primeiro de `vitest.unit.config.*` e `vitest.config.*` (`.mts`, `.ts`, `.mjs`, `.js`, `.cts`, `.cjs`). Dos blocos `test: {…}` valem `include`, `exclude`, `setupFiles`, `globals`, `testTimeout` e `environment` escritos como literais; `...configDefaults.exclude` é entendido e valores calculados em runtime são ignorados. `mergeConfig` com configs locais importados é seguido, e as listas se concatenam como no Vitest. Sem config do Vitest, vale a convenção acima.

Um `quality-flare.json` na raiz sobrescreve, chave por chave, o que veio do config do Vitest. Use-o só para o que difere no Workers:

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
- **`setupFiles`:** rodam de novo antes de cada arquivo de teste, como no Vitest.
- **`globals`:** `describe`, `it`, `test`, `expect`, `vi`, `beforeEach` e os demais hooks ficam globais.

## Limitações

- **Sem rede:** o Dynamic Worker roda com `globalOutbound: null`. Qualquer `fetch` real falha; faça stub com `vi.stubGlobal("fetch", vi.fn(...))`.
- **Mocks de módulo parciais:** sem automock (`vi.mock` sem factory, pasta `__mocks__`), `vi.doMock` e `vi.unmock`; lançam erro explicando isso. `vi.resetModules()` faz os `import()` literais seguintes do arquivo carregarem cópias novas dos módulos do repositório, com cópias para um reset por teste (até 32); pacotes do npm continuam compartilhados. Um módulo é avaliado uma vez por lote: o que ele calcula ao ser importado não muda entre arquivos com mocks diferentes.
- **Sem snapshots** (`toMatchSnapshot`, `toMatchInlineSnapshot`) e sem `expect.poll`.
- **Playwright fica de fora:** `*.spec.ts` que importa `@playwright/test` não é rodado. Specs que só importam fixtures locais do Playwright ainda são pegos; mova-os para uma pasta ignorada ou renomeie.
- **Lotes:** os arquivos de teste rodam em lotes de 5, cada lote num Dynamic Worker próprio, só com o código que aqueles arquivos importam. Os lotes passam por uma Cloudflare Queue (`quality-flare-tests`) e rodam até 50 em paralelo. Um lote que passa de 48 MB de código, ou cujo Worker cai, se divide ao meio até caber ou até isolar o arquivo culpado. Um arquivo sozinho com mais de 64 MB de imports (Next.js inteiro, por exemplo) aparece como falha com o tamanho.
- **Config do Vitest parcial:** só `include`, `exclude`, `setupFiles`, `globals`, `testTimeout` e `environment` são lidos (veja Configuração); aliases do Vite e plugins são ignorados.
- **Runtime do Workers, não o Node:** `process.cwd()` é `/bundle`, onde os arquivos de texto do repositório (até 1 MB cada, 16 MB no total) podem ser lidos com `node:fs`, só leitura; um arquivo que o lote também importa como módulo é lido já compilado (sem tipos). `import.meta.url`/`dirname` e `__dirname` apontam para lá. Não há `child_process` nem processos, nem `vm`; `Date.now()` só avança em I/O. APIs do Node que o `nodejs_compat` não implementa falham.
- **Sem `eval`/`new Function`:** um `Function("…return function…")` (o protobufjs do `firebase-admin` faz isso ao carregar) devolve uma função que lança `EvalError` só quando chamada, então importar funciona; outros usos (ajv, `RuleTester` do ESLint) falham na hora.
- **Valores aleatórios ao importar:** o Workers os proíbe enquanto um módulo é avaliado; ali `crypto.randomUUID`/`getRandomValues` e `randomBytes`/`randomFillSync`/`randomUUID` do `node:crypto` usam `Math.random`. Dentro dos testes, a fonte criptográfica de sempre. Timers e I/O durante o import continuam proibidos.
- **Pacotes:** só os que estão no lockfile e no registry público do npm. Sem lockfile, ou com yarn/bun, só imports relativos e `vitest` funcionam. Registries privados e dependências git não são resolvidos. Pacotes que precisam de binário nativo ou de WebAssembly compilado em runtime não funcionam; o `sharp` pode ser importado e falha ao ser usado.
- **Limites:** 30 s de CPU por lote no Dynamic Worker e 128 MB de memória no Worker que monta o lote. Um lote que derruba o Worker três vezes é reportado como falha.
- Os testes de todos os arquivos rodam no mesmo isolate, um arquivo depois do outro, e cada pacote é avaliado uma vez por lote. Hooks que um pacote registra ao ser importado (o `afterEach(cleanup)` do `@testing-library/react`) valem para todos os arquivos coletados depois dele. Estado global vaza entre arquivos: limpe stubs em `afterEach` (`vi.unstubAllGlobals()`, `vi.restoreAllMocks()`).
- Um módulo que algum arquivo do lote mocka e que falha ao carregar de verdade só derruba, nos outros arquivos, o teste que usa um export dele; o erro original aparece nesse uso.

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

Cada execução fica registrada em **Execuções de testes** no admin (`/admin/runs`). Enquanto roda, a página mostra ao vivo cada teste que termina; depois, o resultado com cada arquivo, cada teste e a mensagem de cada falha. Uma execução tem 60 minutos: depois disso, os lotes que ainda estão na fila marcam seus arquivos como falha sem rodá-los e a execução termina. Uma que fica "rodando" por mais de 75 minutos foi cortada e aparece como interrompida; use **Re-run** na PR.

O check run mostra uma tabela por arquivo e uma seção por falha:

- **Teste que falhou:** nome completo (`suite › teste`), arquivo e a mensagem do `expect`, com diff.
- **Arquivo quebrado** (erro fora de um teste): o import falhou ou um `beforeAll`/`afterAll` lançou erro. Erros como `does not provide an export named 'x'` vindos de `/__qf/missing/<nome>.js` querem dizer que aquele import não foi resolvido. A seção **Imports não resolvidos** lista cada um, com o arquivo de origem.
- **"Nenhum teste encontrado"** (neutro): nenhum arquivo segue a convenção.
- **"Não foi possível rodar os testes"**: o download ou a montagem falhou antes de rodar. Um 403/404 ao baixar o código de um repositório privado quer dizer que falta a permissão Contents: Read-only na App, ou que a instalação ainda não aceitou essa permissão.

## Reproduzir localmente

A suíte de testes do próprio quality-flare tem um teste que sobe o `workerd` com um binding de Worker Loader e roda um repositório de exemplo do mesmo jeito que o check: [`test/checks/tests/dynamic-worker.test.ts`](../../../test/checks/tests/dynamic-worker.test.ts). Para rodar a suíte de outro repositório localmente, adapte o `runInWorkerd` desse arquivo: monte o mapa `caminho → conteúdo` com `buildModules` e chame o host.
