# Getting started

This page connects one repository to a quality-flare instance and gets its first check runs. It assumes the instance exists; if it doesn't, start with [Self-hosting](self-hosting.md).

You need admin rights on the repository, to install the App and change branch protection, and access to the instance's admin (an email that its Cloudflare Access policy allows).

## 1. Install the App on the repository

The instance's GitHub App is created on its `/setup` page. Open the admin at `https://<your-instance>/admin` and follow **Conectar outros repositórios** ("connect more repositories"), or open the App's page on GitHub and choose **Install** or **Configure**. Pick the repositories quality-flare should see.

> The admin and the check runs' texts are in Portuguese. This page names each control as it appears, with a translation.

## 2. Turn the repository on in the admin

Everything starts off, so installing the App changes nothing yet.

1. In `/admin`, find the repository and turn on its **Ativar checks** switch ("enable checks"). From now on the Worker handles its webhooks.
2. Click the repository to open its checks and turn on the ones you want. **Ativar todos** turns them all on.

A check that is off in an enabled repository still reports, as **neutral**, so a check that branch protection requires never blocks a merge just because it is off.

A good first set is **Closes an issue**, which needs no setup, and one of the two test checks; [Running tests](running-tests.md#tests-or-container-tests) helps you pick.

## 3. Open a pull request

Open a pull request, or push to an existing one, and the checks appear among its check runs. Each check run links to its run in the admin, where test runs show each test live.

If nothing appears:

- the repository's switch is off in the admin, or the App isn't installed on it;
- the test checks only run on pushes, opening, reopening and leaving draft, not on label or description changes;
- with [tests on demand](on-demand.md) on, the test checks wait for a `/quality-flare run` comment.

## 4. Require the checks

In the repository's **Settings → Rules** (or **Branch protection**), require the check runs that should block merging, such as **Closes an issue** or **Container tests**. Each [command](running-tests.md#add-commands-typecheck-lint) of Container tests is its own check run, and can be required on its own.

## Next

- [Running tests](running-tests.md): configure Tests or Container tests for your repository.
- [Tests on demand](on-demand.md): run tests only when a pull request is ready.
- [Checks](checks.md): what each check passes, fails and skips.
