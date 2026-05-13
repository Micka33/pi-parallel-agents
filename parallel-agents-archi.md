# Architecture fichiers — pi-parallel-agents

Ce document décrit l’architecture cible des dossiers et fichiers nécessaires pour implémenter les 3 versions du plan `parallel-agents-plan.md`.

## Principes

- L’extension TypeScript expose les tools, les commandes TUI, le widget, l’overlay et le routage RPC.
- Les scripts shell sont la frontière de lifecycle : création, reprise, arrêt, nettoyage et écriture de l’état durable.
- `state.sqlite` est la source de vérité des agents ; l’extension le lit, les scripts l’écrivent.
- `tasks.sqlite` est la source de vérité des queues de questions via `pi-tasks`.
- Les worktrees sont créés hors repo, dans `../pi/<worktree-name>`.
- Les fichiers runtime restent sous `.pi/parallel-agents/` et ne sont pas versionnés.
- Le mode `consult` reste un mode de `message_parallel_agent`, pas un tool public séparé.

## Arborescence cible

```text
pi-parallel-agents/
├── README.md
├── parallel-agents-plan.md
├── parallel-agents-archi.md
├── package.json
├── tsconfig.json
├── src/
│   ├── parallel-agents.ts
│   ├── constants.ts
│   ├── config/
│   │   ├── defaults.ts
│   │   ├── resolve-agent-options.ts
│   │   └── task-presets.ts
│   ├── tools/
│   │   ├── index.ts
│   │   ├── schemas.ts
│   │   ├── launch-parallel-agents.ts
│   │   ├── get-parallel-agents.ts
│   │   ├── message-parallel-agent.ts
│   │   ├── reply-parallel-question.ts
│   │   └── control-parallel-agent.ts
│   ├── commands/
│   │   ├── index.ts
│   │   ├── agents.ts
│   │   ├── agents-open.ts
│   │   ├── agents-summary.ts
│   │   ├── agents-steer.ts
│   │   ├── agents-ask.ts
│   │   ├── agents-consult.ts
│   │   ├── agents-stop.ts
│   │   ├── agents-resume.ts
│   │   ├── agents-defaults.ts
│   │   └── agents-clean.ts
│   ├── tui/
│   │   ├── widget.ts
│   │   ├── overlay.ts
│   │   ├── render-agents.ts
│   │   ├── render-queues.ts
│   │   └── actions.ts
│   ├── state/
│   │   ├── state-reader.ts
│   │   ├── selectors.ts
│   │   ├── types.ts
│   │   └── migrations.ts
│   ├── lifecycle/
│   │   ├── script-runner.ts
│   │   ├── start-agent.ts
│   │   ├── stop-agent.ts
│   │   ├── resume-agent.ts
│   │   ├── clean-agent.ts
│   │   └── refresh-agents.ts
│   ├── rpc/
│   │   ├── pi-rpc-client.ts
│   │   ├── rpc-registry.ts
│   │   ├── commands.ts
│   │   ├── events.ts
│   │   └── session.ts
│   ├── queues/
│   │   ├── pi-tasks-adapter.ts
│   │   ├── question-router.ts
│   │   ├── question-ids.ts
│   │   └── delivery.ts
│   ├── consult/
│   │   ├── consult-clone.ts
│   │   └── consult-result.ts
│   ├── security/
│   │   ├── access-mode.ts
│   │   ├── confirmations.ts
│   │   └── current-workspace-guards.ts
│   ├── prompts/
│   │   ├── child-agent.md
│   │   ├── child-read-only.md
│   │   ├── naming-agent.md
│   │   ├── consult-clone.md
│   │   └── question-routing.md
│   └── util/
│       ├── ids.ts
│       ├── json.ts
│       ├── paths.ts
│       ├── logger.ts
│       └── errors.ts
├── scripts/
│   ├── start-parallel-agent.sh
│   ├── stop-parallel-agent.sh
│   ├── clean-parallel-agent.sh
│   ├── parallel-agent-state.sh
│   ├── consult-subagent-clone.sh
│   ├── lib/
│   │   ├── args.sh
│   │   ├── json.sh
│   │   ├── sqlite.sh
│   │   ├── state.sh
│   │   ├── git-worktree.sh
│   │   ├── pi-rpc.sh
│   │   ├── naming-agent.sh
│   │   ├── access-mode.sh
│   │   ├── sanitize.sh
│   │   ├── locks.sh
│   │   └── logging.sh
│   └── sql/
│       ├── 001_state_schema.sql
│       └── 002_state_indexes.sql
├── schemas/
│   ├── context.schema.json
│   ├── start-result.schema.json
│   ├── agent-state.schema.json
│   ├── queue-message.schema.json
│   └── consult-result.schema.json
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── scripts/
│   ├── fixtures/
│   │   ├── fake-pi-rpc.ts
│   │   ├── sample-context.json
│   │   └── repo-with-worktree.sh
│   └── support/
│       ├── temp-repo.ts
│       └── fake-sqlite.ts
└── examples/
    ├── launch-three-agents.md
    ├── current-read-only.md
    └── consult-clone.md
```

## Fichiers runtime non versionnés

```text
.pi/
└── parallel-agents/
    ├── state.sqlite
    ├── tasks.sqlite
    ├── logs/
    │   ├── extension.log
    │   └── agents/<agent-id>.log
    ├── locks/
    ├── tmp/
    └── consult/
```

Les worktrees créés par défaut sont en dehors du repo :

```text
../pi/
├── agent-api-refactor/
├── agent-tests/
└── agent-docs/
```

## Responsabilités des dossiers TypeScript

### `src/parallel-agents.ts`

Point d’entrée de l’extension Pi.

Il enregistre :

- les 5 tools publics ;
- les commandes TUI ;
- le widget permanent ;
- l’overlay interactif ;
- les handlers d’événements RPC ;
- le rafraîchissement initial depuis `state.sqlite`.

### `src/tools/`

Implémente la surface tool stable :

- `launch_parallel_agents` ;
- `get_parallel_agents` ;
- `message_parallel_agent` ;
- `reply_parallel_question` ;
- `control_parallel_agent`.

`schemas.ts` contient les schémas de validation des arguments et des retours. Les tools ne doivent pas écrire directement dans `state.sqlite` : toute mutation d’état passe par `src/lifecycle/` puis par un script.

### `src/commands/`

Fait correspondre les commandes TUI aux tools internes :

- `/agents`, `/agents-open`, `/agents-summary` → `get_parallel_agents` ;
- `/agents-steer`, `/agents-ask`, `/agents-consult` → `message_parallel_agent` ;
- `/agents-stop`, `/agents-resume`, `/agents-defaults`, `/agents-clean` → `control_parallel_agent`.

### `src/tui/`

Contient le rendu UI :

- `widget.ts` : statut compact permanent ;
- `overlay.ts` : panneau multi-agents ;
- `render-agents.ts` : lignes agent, workspace, session, modèle/thinking ;
- `render-queues.ts` : questions entrantes/sortantes ;
- `actions.ts` : actions utilisateur déclenchées depuis l’overlay.

### `src/state/`

Lecture du modèle durable.

- `state-reader.ts` ouvre `state.sqlite` en lecture ;
- `selectors.ts` assemble agents, events, queues et résultats ;
- `types.ts` définit les types `AgentState`, `AgentStatus`, `WorkspaceMode`, `AccessMode` ;
- `migrations.ts` vérifie la compatibilité du schéma attendu.

Aucun `INSERT`, `UPDATE` ou `DELETE` direct dans ce dossier.

### `src/lifecycle/`

Pont TypeScript vers les scripts shell.

- `script-runner.ts` exécute les scripts avec `spawn(..., { shell: false })`, parse le JSON et normalise les erreurs ;
- `start-agent.ts` appelle `start-parallel-agent.sh` ;
- `resume-agent.ts` appelle `start-parallel-agent.sh --resume-session` ;
- `stop-agent.ts` appelle `stop-parallel-agent.sh` après éventuel `abort` RPC ;
- `clean-agent.ts` appelle `clean-parallel-agent.sh` ;
- `refresh-agents.ts` vérifie les `pid`, interroge `get_state` quand possible, puis appelle `parallel-agent-state.sh`.

### `src/rpc/`

Gère les processus Pi RPC vivants.

- `pi-rpc-client.ts` encode/décode les commandes RPC Pi ;
- `rpc-registry.ts` associe `agentId` à un transport RPC actif ;
- `commands.ts` expose `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `set_thinking_level` ;
- `events.ts` route `agent_start`, `turn_start`, `turn_end`, `agent_end`, `queue_update`, `extension_ui_request` ;
- `session.ts` extrait et valide `sessionId`/`sessionFile`.

### `src/queues/`

Adapte `pi-tasks` au protocole parallel-agents.

- `pi-tasks-adapter.ts` lit/écrit dans `tasks.sqlite` ;
- `question-router.ts` route main → sous-agent et sous-agent → main ;
- `question-ids.ts` produit des `questionId` stables et idempotents ;
- `delivery.ts` gère `queued`, `claimed`, `delivered`, `answered`, `done`, `blocked`.

### `src/consult/`

Implémente le mode `consult` de `message_parallel_agent`.

- `consult-clone.ts` appelle `scripts/consult-subagent-clone.sh` ;
- `consult-result.ts` normalise la réponse et le nettoyage.

La question est passée comme argument protégé :

```ts
spawn(scriptPath, [
  "--agent-id", agentId,
  "--question", question,
  "--thinking", "xhigh"
], { shell: false });
```

### `src/security/`

Centralise les garde-fous :

- refus par défaut de `current/write` ;
- confirmation explicite pour écrire dans le checkout courant ;
- refus de plusieurs agents `current/write` en parallèle ;
- toolset lecture seule pour `accessMode = "read_only"` ;
- vérification que `consult` ne cible pas un agent `workspaceMode = "current"`.

### `src/prompts/`

Prompts versionnés utilisés par l’extension et les scripts.

- `child-agent.md` : consigne générale d’un sous-agent ;
- `child-read-only.md` : consigne stricte pour observation/triage ;
- `naming-agent.md` : demande JSON pour `displayName`, `worktreeName`, `branchName` ;
- `consult-clone.md` : consigne pour répondre sans polluer l’agent source ;
- `question-routing.md` : consigne pour poser une question au main agent.

Les presets de tâches doivent être observation-first : un sous-agent commence par lire/analyser, puis ne modifie que si son `accessMode` et sa tâche l’autorisent explicitement.

## Responsabilités des scripts

### `scripts/start-parallel-agent.sh`

Implémente création et reprise.

Responsabilités :

- résoudre `repoRoot`, `workspaceMode`, `accessMode`, `provider`, `model`, `thinking` ;
- écrire `status = "starting"` dans `state.sqlite` ;
- appeler le naming agent uniquement en mode `worktree` ;
- créer le worktree dans `../pi/<worktree-name>` ;
- lancer ou reprendre Pi RPC ;
- appliquer le toolset lecture seule si nécessaire ;
- envoyer le prompt initial ;
- récupérer `sessionId`/`sessionFile` via `get_state` ;
- écrire `pid`, `sessionId`, `sessionFile`, `cwd`, `status` dans SQLite ;
- retourner un JSON conforme à `schemas/start-result.schema.json`.

### `scripts/parallel-agent-state.sh`

Seul point d’écriture générique dans `state.sqlite`.

Actions attendues :

- `init` ;
- `upsert-agent` ;
- `set-status` ;
- `append-event` ;
- `set-result` ;
- `set-defaults` ;
- `mark-done` ;
- `mark-crashed`.

Toutes les écritures doivent être transactionnelles et idempotentes sur `agent_id`.

### `scripts/stop-parallel-agent.sh`

Arrêt propre ou forcé.

Responsabilités :

- relire l’agent depuis SQLite ;
- terminer le processus si l’extension ne l’a pas déjà fermé ;
- tenter `SIGTERM`, puis `SIGKILL` en dernier recours ;
- écrire `status = "stopped"` et `pid = null` ;
- ne jamais supprimer worktree, branche ou session.

### `scripts/clean-parallel-agent.sh`

Nettoyage conservateur.

Responsabilités :

- refuser un worktree dirty sauf `force` ;
- supprimer un worktree seulement si demandé ;
- supprimer une branche seulement avec confirmation explicite ;
- supprimer une session seulement avec option explicite ;
- marquer `status = "cleaned"` ou conserver l’historique selon l’option utilisateur.

### `scripts/consult-subagent-clone.sh`

Consultation isolée en version 3.

Responsabilités :

- refuser `workspaceMode = "current"` ;
- cloner temporairement le worktree et la session source ;
- lancer un Pi RPC temporaire avec `thinking = "xhigh"` ;
- passer la question via `--question` ;
- utiliser le toolset lecture seule par défaut ;
- retourner la réponse au parent ;
- nettoyer le clone temporaire sauf mode debug.

## Architecture par version

### Version 1 — lancement, état, lecture

Fichiers nécessaires :

```text
src/parallel-agents.ts
src/constants.ts
src/config/defaults.ts
src/config/resolve-agent-options.ts
src/config/task-presets.ts
src/tools/index.ts
src/tools/schemas.ts
src/tools/launch-parallel-agents.ts
src/tools/get-parallel-agents.ts
src/commands/index.ts
src/commands/agents.ts
src/commands/agents-open.ts
src/commands/agents-summary.ts
src/tui/widget.ts
src/tui/render-agents.ts
src/state/state-reader.ts
src/state/selectors.ts
src/state/types.ts
src/lifecycle/script-runner.ts
src/lifecycle/start-agent.ts
src/lifecycle/refresh-agents.ts
src/rpc/pi-rpc-client.ts
src/rpc/rpc-registry.ts
src/rpc/commands.ts
src/rpc/session.ts
src/security/access-mode.ts
src/security/current-workspace-guards.ts
src/prompts/child-agent.md
src/prompts/child-read-only.md
src/prompts/naming-agent.md
scripts/start-parallel-agent.sh
scripts/parallel-agent-state.sh
scripts/lib/*.sh
scripts/sql/001_state_schema.sql
schemas/context.schema.json
schemas/start-result.schema.json
schemas/agent-state.schema.json
```

Livrable : lancer des sous-agents, créer les worktrees, persister l’état, afficher `/agents`, `/agents-open`, `/agents-summary` et le widget minimal.

### Version 2 — contrôle et messagerie durable

Fichiers ajoutés ou complétés :

```text
src/tools/message-parallel-agent.ts
src/tools/reply-parallel-question.ts
src/tools/control-parallel-agent.ts
src/commands/agents-steer.ts
src/commands/agents-ask.ts
src/commands/agents-stop.ts
src/commands/agents-resume.ts
src/commands/agents-defaults.ts
src/commands/agents-clean.ts
src/tui/overlay.ts
src/tui/render-queues.ts
src/tui/actions.ts
src/lifecycle/stop-agent.ts
src/lifecycle/resume-agent.ts
src/lifecycle/clean-agent.ts
src/rpc/events.ts
src/queues/pi-tasks-adapter.ts
src/queues/question-router.ts
src/queues/question-ids.ts
src/queues/delivery.ts
src/prompts/question-routing.md
scripts/stop-parallel-agent.sh
scripts/clean-parallel-agent.sh
schemas/queue-message.schema.json
```

Livrable : arrêter/reprendre/nettoyer, gérer les statuts complets, envoyer `steer`/`queue`, recevoir et répondre aux questions, persister les queues dans `tasks.sqlite`.

### Version 3 — consultation isolée et UX avancée

Fichiers ajoutés ou complétés :

```text
src/commands/agents-consult.ts
src/consult/consult-clone.ts
src/consult/consult-result.ts
src/security/confirmations.ts
src/tui/overlay.ts
src/tui/actions.ts
src/tools/message-parallel-agent.ts
src/prompts/consult-clone.md
scripts/consult-subagent-clone.sh
schemas/consult-result.schema.json
examples/consult-clone.md
```

Livrable : mode `consult`, clone temporaire en lecture seule, `thinking = "xhigh"`, retry explicite des questions bloquées, overlay multi-agents complet et garde-fous renforcés pour `current/write`.

## Ordre d’implémentation conseillé

1. Créer `package.json`, `tsconfig.json`, l’entrée `src/parallel-agents.ts` et les types de base.
2. Implémenter le schéma SQLite et `parallel-agent-state.sh`.
3. Implémenter `start-parallel-agent.sh` avec naming agent, worktree et mode `current/read_only`.
4. Implémenter `launch_parallel_agents` et `get_parallel_agents`.
5. Ajouter le widget et les commandes de lecture.
6. Ajouter stop/resume/clean et les statuts complets.
7. Ajouter `pi-tasks`, `message_parallel_agent`, `reply_parallel_question` et les queues.
8. Ajouter l’overlay.
9. Ajouter le mode `consult` et le script de clone temporaire.
10. Ajouter les tests d’intégration avec fake Pi RPC et repos temporaires.
