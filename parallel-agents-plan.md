# Plan — Agents parallèles dans Pi

## Objectif

Ajouter à Pi une capacité de lancement de plusieurs sous-agents en parallèle depuis un prompt principal.

Chaque sous-agent doit :

- être créé par un script shell d’amorçage appelé par l’agent principal ;
- créer par défaut son propre `git worktree` ;
- pouvoir aussi être lancé sans worktree, directement dans le repo courant, en lecture seule par défaut ;
- travailler soit dans `../pi/<worktree-name>` où `..` est le dossier parent de la racine du projet courant, soit dans `repoRoot` en mode sans worktree ;
- avoir un nom de worktree/branche proposé par un agent Pi à partir du contexte fourni, puis validé/sanitisé par le script, uniquement lorsqu’un worktree est créé ;
- utiliser le même harness Pi que l’agent principal ;
- utiliser le modèle et le niveau de thinking demandés par l’agent principal, avec défaut `gpt-5.5` / `high` ;
- exposer un `sessionId`/`sessionFile` Pi au parent pour pouvoir être relancé ;
- inscrire et mettre à jour son état dans une base SQLite via les scripts de lifecycle ;
- pouvoir être arrêté à tout moment par l’agent principal sans supprimer son worktree éventuel ni sa session ;
- pouvoir être repris par l’agent principal depuis sa session persistée ;
- avoir un espace dédié dans la TUI ;
- pouvoir poser des questions à l’utilisateur ;
- pouvoir poser des questions à l’agent principal ;
- pouvoir être steeré par l’utilisateur pendant son exécution.

## Architecture proposée

Construire une extension Pi appelée par exemple `parallel-agents.ts`.

Cette extension orchestre des sous-agents Pi lancés via des scripts shell de lifecycle.

Scripts principaux :

- `scripts/start-parallel-agent.sh` : création et reprise ;
- `scripts/stop-parallel-agent.sh` : arrêt propre ou forcé ;
- `scripts/clean-parallel-agent.sh` : nettoyage conservateur ;
- `scripts/parallel-agent-state.sh` : initialisation et mises à jour SQLite.

Les scripts sont les seuls composants qui écrivent l’état durable des agents. L’extension expose des tools pour consulter et gérer cet état, mais elle délègue les mutations aux scripts, puis relit SQLite.

Le transport RPC vivant peut rester détenu par l’extension, notamment si Pi RPC fonctionne sur `stdin`/`stdout`. Dans ce cas, l’extension envoie les commandes RPC (`prompt`, `steer`, `follow_up`, `abort`) puis appelle les scripts pour les changements de lifecycle, de processus et de SQLite.

```bash
scripts/start-parallel-agent.sh --context <context.json> --prompt <prompt.md>
```

Le processus enfant lancé par le script reste un Pi RPC standard :

```bash
cd <agent-cwd>
pi --mode rpc --provider <provider> --model <model> --thinking <level>
```

`agent-cwd` vaut soit le chemin du worktree créé, soit `repoRoot` en mode sans worktree.

Le niveau de thinking est appliqué par le script au démarrage avec `--thinking <level>`, puis vérifié via `get_state`. Si nécessaire, le script corrige avec la commande RPC `set_thinking_level`.

En reprise, le même script relance Pi dans le même workspace avec la session persistée :

```bash
cd <agent-cwd>
pi --mode rpc --provider <provider> --model <model> --thinking <level> --session <session-file-or-id>
```

Chaque sous-agent est un vrai processus Pi indépendant, avec :

- son propre `cwd`, pointant par défaut vers son worktree, ou vers le repo courant en mode sans worktree ;
- une session Pi persistante identifiée par `sessionId` et `sessionFile` ;
- un modèle choisi par l’agent principal ;
- un niveau de thinking choisi par l’agent principal ;
- par défaut `model = "gpt-5.5"` et `thinking = "high"`, sauf si l’utilisateur ou l’agent principal spécifie autre chose ;
- les mêmes credentials Pi ;
- les mêmes tools de base en `accessMode = "write"`, ou le jeu de tools lecture seule en `read_only` ;
- les mêmes skills/prompts/extensions utiles.

Le choix du mode RPC permet :

- une isolation de processus propre ;
- le vrai runtime Pi ;
- la réception des events de streaming ;
- l’envoi de messages `prompt`, `steer`, `follow_up`, `abort` ;
- le routage du protocole `extension_ui_request` vers l’interface TUI principale.

L’isolation des fichiers n’est garantie que pour les agents lancés avec worktree. En mode sans worktree, l’agent partage le même dossier de travail que l’agent principal. Pour réduire le risque, ce mode est lancé en lecture seule par défaut.

## État durable des agents

La source de vérité des agents est une base SQLite dédiée :

```bash
<repoRoot>/.pi/parallel-agents/state.sqlite
```

Cette base stocke les agents, leurs statuts, leurs sessions, leurs workspaces, leurs résultats et la configuration par défaut. Elle est distincte de la base `pi-tasks`, qui sert aux queues de questions.

Règle simple : l’extension ne modifie pas directement cette base. Elle appelle un script de lifecycle, ou `scripts/parallel-agent-state.sh`, puis relit SQLite.

Schéma minimal :

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_mode TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  session_id TEXT,
  session_file TEXT,
  summary TEXT,
  diff_summary TEXT,
  tests_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Statuts simples :

| Statut | Sens |
| --- | --- |
| `starting` | création ou reprise en cours |
| `running` | processus RPC vivant et en train de travailler |
| `waiting` | processus RPC vivant, sans tour actif |
| `stopped` | arrêt volontaire, reprenable |
| `crashed` | arrêt inattendu ou démarrage échoué, reprenable si `session_file` et `cwd` existent |
| `done` | tâche terminée et résultat disponible |
| `cleaned` | ressources nettoyées, conservé seulement pour historique |

Transitions principales :

```text
starting -> running | waiting | crashed
running  -> waiting | done | stopped | crashed
waiting  -> running | done | stopped | crashed
stopped  -> starting | cleaned
crashed  -> starting | cleaned
done     -> starting | cleaned
```

Les tools de l’extension consultent et gèrent cet état :

- `get_parallel_agents` lit `agents`, `agent_events` et les résultats associés ;
- `launch_parallel_agents` appelle `start-parallel-agent.sh`, qui upsert l’agent dans SQLite ;
- `control_parallel_agent` appelle les scripts `stop`, `start/resume`, `clean` ou `parallel-agent-state.sh` selon l’action ;
- `message_parallel_agent` et `reply_parallel_question` mettent à jour les queues via `pi-tasks`, puis l’état agent via `parallel-agent-state.sh` si nécessaire.

Au démarrage, l’extension ouvre `state.sqlite`, affiche les agents connus, appelle `control_parallel_agent({ action: "refresh" })`, puis marque les processus introuvables comme `crashed` ou `stopped` selon leur dernier arrêt connu.

## Script d’amorçage d’un agent enfant

L’agent principal ne crée pas directement un enfant en TypeScript. Il appelle un script shell qui encapsule la stratégie de création/reprise.

Contrat minimal du script :

```bash
scripts/start-parallel-agent.sh \
  --context <context.json> \
  --prompt <prompt.md> \
  --provider <provider> \
  --model <model> \
  --thinking <level> \
  [--workspace-mode worktree|current] \
  [--access-mode read_only|write] \
  [--resume-session <session-file-or-id>] \
  [--cwd <existing-workspace>] \
  [--worktree-path <existing-worktree>] \
  [--state-db <absolute-path-to-state.sqlite>] \
  [--tasks-db <absolute-path-to-shared-tasks.sqlite>]
```

Le script propage aussi aux processus enfants les variables nécessaires à l’état partagé et aux queues :

```bash
PI_PARALLEL_AGENTS_DB_PATH=<repoRoot>/.pi/parallel-agents/state.sqlite
PI_TASKS_DB_PATH=<repoRoot>/.pi/parallel-agents/tasks.sqlite
PI_TASKS_AGENT_ID=parallel-child:<agent-id>
```

L’agent principal utilise une identité stable distincte, par exemple `PI_TASKS_AGENT_ID=parallel-main:<main-session-id>`, pour les claims de livraison.

Comportement par défaut, sans `--resume-session` :

1. reçoit le contexte du parent : racine repo, prompt utilisateur, tâche du sous-agent, contraintes, noms déjà utilisés, worktrees existants, modèle, thinking, mode de workspace et mode d’accès demandés ;
2. résout `workspaceMode`, avec `worktree` par défaut ;
3. résout `accessMode`, avec `write` par défaut en mode `worktree` et `read_only` par défaut en mode `current` ;
4. écrit ou met à jour la ligne agent avec `status = "starting"` ;
5. si `workspaceMode = "worktree"` :
   1. appelle un agent Pi dédié au naming avec ce contexte ;
   2. ce naming agent utilise le même `provider` et le même `model` que le sous-agent, mais avec `thinking = "off"` et sans tools (`--no-tools`) ;
   3. récupère une proposition structurée, par exemple :

      ```json
      {
        "displayName": "api",
        "worktreeName": "agent-api-refactor",
        "branchName": "agent-api-refactor"
      }
      ```

   4. sanitise et déduplique `worktreeName`/`branchName` côté script ;
   5. crée le worktree ;
   6. définit `agentCwd = worktreePath` ;

6. si `workspaceMode = "current"` :
   1. ne crée ni branche ni worktree ;
   2. définit `agentCwd = repoRoot` ;
   3. conserve `branchName = null` et `worktreePath = null` ;
   4. impose `accessMode = "read_only"` sauf demande explicite d’écriture validée ;
7. exécute `cd <agent-cwd>` ;
8. construit la commande Pi RPC avec `--provider <provider>`, `--model <model>`, `--thinking <level>` et, si `accessMode = "read_only"`, `--tools read,grep,find,ls,message_parallel_agent,reply_parallel_question,get_parallel_agents` ;
9. lance l’agent Pi dédié en mode RPC ;
10. envoie le prompt initial ;
11. interroge `get_state` pour obtenir `sessionId` et `sessionFile` ;
12. met à jour SQLite avec `pid`, `sessionId`, `sessionFile` et `status = "running"` ou `"waiting"` ;
13. retourne au parent un JSON de suivi :

```json
{
  "agentId": "api",
  "displayName": "api",
  "pid": 12345,
  "workspaceMode": "worktree",
  "accessMode": "write",
  "cwd": "../pi/agent-api-refactor",
  "provider": "openai",
  "model": "gpt-5.5",
  "thinking": "high",
  "branchName": "agent-api-refactor",
  "worktreePath": "../pi/agent-api-refactor",
  "sessionId": "abc123",
  "sessionFile": "/Users/.../.pi/agent/sessions/...jsonl",
  "status": "running"
}
```

En mode sans worktree, le JSON contient notamment :

```json
{
  "workspaceMode": "current",
  "accessMode": "read_only",
  "cwd": "/path/to/repo",
  "branchName": null,
  "worktreePath": null
}
```

Comportement en reprise, avec `--resume-session` :

1. relit `workspaceMode`, `accessMode`, `cwd`, `worktreePath`, `branchName`, `sessionId`, `sessionFile`, `provider`, `model` et `thinking` depuis SQLite ;
2. vérifie que le workspace existe encore (`worktreePath` en mode worktree, `repoRoot`/`cwd` en mode current) ;
3. exécute `cd <agent-cwd>` ;
4. met SQLite à jour avec `status = "starting"` ;
5. relance Pi RPC avec `--provider`, `--model`, `--thinking`, `--session` et le jeu de tools correspondant à `accessMode` ;
6. retourne un nouveau `pid` en conservant le même `agentId` logique ;
7. met SQLite à jour avec le nouveau `pid` et `status = "running"` ou `"waiting"`.

## Configuration modèle et thinking des sous-agents

L’agent principal doit pouvoir choisir le modèle et le niveau de thinking utilisés par les sous-agents.

Valeurs par défaut initiales :

```text
model: gpt-5.5
thinking: high
```

Le `provider` est résolu à partir du modèle quand c’est possible, ou depuis la configuration Pi active.

Si l’utilisateur demande explicitement un autre modèle ou un autre niveau de thinking dans le prompt principal, l’agent principal doit les transmettre au lancement des sous-agents.

Ordre de priorité pour résoudre `model` et `thinking` :

1. valeur explicitement définie pour un agent dans `launch_parallel_agents.agents[]` ;
2. valeur définie pour tout le lancement via `launch_parallel_agents.defaultModel` / `defaultThinking` ;
3. valeur par défaut courante configurée par commande ;
4. fallback `gpt-5.5` / `high`.

L’extension expose une commande pour consulter ou modifier les valeurs par défaut des prochains sous-agents :

```text
/agents-defaults
/agents-defaults --model gpt-5.5 --thinking high
/agents-defaults --model <model>
/agents-defaults --thinking <off|minimal|low|medium|high|xhigh>
```

Sans argument, la commande affiche la configuration courante depuis SQLite. Avec arguments, elle appelle `parallel-agent-state.sh` pour mettre à jour `settings`. Le changement affecte les futurs agents et les reprises explicitement demandées avec override, mais ne modifie pas automatiquement les agents déjà lancés.

Chaque agent enfant garde dans ses métadonnées le modèle et le thinking utilisés à sa création :

```json
{
  "agentId": "api",
  "model": "gpt-5.5",
  "thinking": "high"
}
```

Lors d’une reprise, le parent réutilise par défaut `model` et `thinking` persistés pour cet agent afin de préserver la continuité de session. Le parent peut toutefois demander une reprise avec override explicite si nécessaire.

## Mode workspace et création des worktrees

Chaque sous-agent a un `workspaceMode` :

- `worktree` : mode par défaut, crée un worktree dédié dans `../pi/<worktree-name>` ;
- `current` : mode sans worktree, lance l’agent directement dans le repo courant (`repoRoot`).

Chaque sous-agent a aussi un `accessMode` :

- `write` : tools d’écriture disponibles, défaut en mode `worktree` ;
- `read_only` : tools limités à `read,grep,find,ls,message_parallel_agent,reply_parallel_question,get_parallel_agents`, défaut en mode `current`.

Le mode `current` est opt-in car il partage les fichiers avec l’agent principal et les autres agents lancés dans le même repo. Par défaut, il sert aux tâches de lecture, d’analyse ou de triage. Pour autoriser l’écriture en mode `current`, il faut une demande explicite (`accessMode = "write"`) et une confirmation utilisateur. L’extension refuse par défaut plusieurs agents `current/write` en parallèle.

Pour chaque nouveau sous-agent en mode `worktree`, le script d’amorçage :

1. Détermine la racine git :

   ```bash
   git rev-parse --show-toplevel
   ```

2. Prépare le contexte envoyé à l’agent Pi de naming :

   ```json
   {
     "repoRoot": "/path/to/repo",
     "repoName": "repo",
     "parentPrompt": "...",
     "agentPrompt": "...",
     "suggestedName": "api",
     "existingWorktrees": ["agent-api", "agent-tests"]
   }
   ```

3. Demande au naming agent de proposer `worktreeName` et `branchName`. Ce naming agent est lancé par le script avec le même modèle que le sous-agent, `thinking = "off"`, `--no-tools` et une session éphémère.

4. Calcule le dossier cible :

   ```text
   repoRoot = racine git du projet courant
   parent = dirname(repoRoot)
   worktreeBase = path.join(parent, "pi")
   worktreePath = path.join(worktreeBase, worktreeName)
   ```

5. Crée le worktree par défaut :

   ```bash
   git worktree add -b <branch-name> ../pi/<worktree-name> HEAD
   ```

6. Gère les collisions de noms, même si le naming agent a proposé un nom déjà pris :

   ```text
   feature-auth   -> ../pi/feature-auth
   feature-auth-2 -> si feature-auth existe déjà
   ```

Les noms de worktrees et de branches doivent être sanitizés par le script, même s’ils ont été produits par un agent Pi. Si le naming agent échoue ou retourne un JSON invalide, le script utilise un nom déterministe dérivé du nom demandé et du timestamp.

Pour chaque nouveau sous-agent en mode `current`, le script :

1. détermine `repoRoot` ;
2. ne lance pas le naming agent pour produire un `worktreeName` ;
3. ne crée pas de branche ;
4. ne crée pas de worktree ;
5. définit `cwd = repoRoot` ;
6. applique `accessMode = "read_only"` par défaut ;
7. lance Pi RPC directement depuis ce dossier, avec le jeu de tools lecture seule.

En mode `current`, l’extension doit afficher clairement que l’agent n’est pas isolé au niveau fichiers. En mode `current/write`, elle doit aussi afficher qu’il peut modifier le checkout courant.

## Déclenchement depuis le prompt

L’extension expose un tool au main agent :

```ts
launch_parallel_agents({
  defaultModel: "gpt-5.5",
  defaultThinking: "high",
  agents: [
    {
      name: "api",
      workspaceMode: "worktree",
      prompt: "Explore/refactor the API layer...",
    },
    {
      name: "triage",
      workspaceMode: "current",
      accessMode: "read_only",
      prompt: "Inspect the current repo without creating a worktree...",
    },
    {
      name: "tests",
      model: "gpt-5.5",
      thinking: "high",
      prompt: "Add regression tests...",
    },
  ],
});
```

Exemple d’usage utilisateur :

```text
Lance 3 agents en parallèle : un pour les tests, un pour l’UI, un pour la doc.
```

Le main agent appelle le tool, puis l’extension :

1. résout `workspaceMode`, `accessMode`, `model` et `thinking` pour chaque sous-agent ;
2. prépare un contexte complet pour chaque sous-agent ;
3. appelle `scripts/start-parallel-agent.sh` pour chaque agent avec `--workspace-mode`, `--access-mode`, `--provider`, `--model`, `--thinking`, `--state-db` et `--tasks-db` ;
4. laisse le script choisir le nom via un naming agent Pi et créer le worktree uniquement en mode `worktree` ;
5. démarre Pi RPC depuis le worktree ou directement depuis `repoRoot` en mode `current` ;
6. récupère le JSON retourné par le script ;
7. laisse le script persister dans SQLite `agentId`, `pid`, `workspaceMode`, `accessMode`, `cwd`, `provider`, `model`, `thinking`, `worktreePath`, `branchName`, `sessionId`, `sessionFile` et `status` ;
8. retourne au main agent les ids logiques des sous-agents et leurs ids de session Pi.

`branchName` ou `worktreeName` peuvent rester optionnels dans l’API. S’ils sont fournis en mode `worktree`, ils servent d’indication au naming agent et au script, mais le script garde la responsabilité finale de sanitation/déduplication. En mode `current`, ils sont ignorés.

`model` et `thinking` sont aussi optionnels dans l’API. S’ils ne sont pas fournis, l’extension utilise la configuration par défaut courante des sous-agents.

`workspaceMode` est optionnel et vaut `worktree` par défaut. Pour lancer un agent sans worktree, le main agent passe `workspaceMode: "current"`.

`accessMode` est optionnel. Il vaut `write` en mode `worktree` et `read_only` en mode `current`. Le passage de `current/read_only` à `current/write` exige une confirmation utilisateur explicite.

## Commandes RPC Pi utilisées

Les noms de commandes RPC utilisés doivent correspondre au protocole Pi :

| Besoin | Commande RPC |
| --- | --- |
| envoyer le prompt initial ou un prompt quand l’agent est idle | `prompt` |
| orienter un agent pendant qu’il travaille | `steer` |
| ajouter un message après le travail courant | `follow_up` |
| annuler le tour courant avant arrêt | `abort` |
| lire session, modèle, thinking, streaming et queues | `get_state` |
| corriger le thinking après démarrage si nécessaire | `set_thinking_level` |
| router une question UI d’un sous-agent | `extension_ui_request` / `extension_ui_response` |

Règles d’usage :

- si `get_state.isStreaming = false`, envoyer un nouveau message avec `prompt` ;
- si `get_state.isStreaming = true` et que le mode demandé est `steer`, utiliser `steer` ;
- si `get_state.isStreaming = true` et que le mode demandé est `queue`, utiliser `follow_up` ou conserver la question dans SQLite jusqu’à la fin du tour ;
- ne pas inventer de commande RPC `pause` : l’arrêt est `abort` puis fermeture du transport et du processus ;
- `agent_start`, `turn_start`, `turn_end`, `agent_end` et `queue_update` servent uniquement à rafraîchir la TUI et à déclencher une mise à jour SQLite via `parallel-agent-state.sh`.

## Interface TUI

### Widget permanent

Afficher un widget au-dessus de l’éditeur :

```text
Parallel agents
● api      running    worktree  gpt-5.5/high   ../pi/agent-api-refactor   session abc123
● triage   running    current/read-only   gpt-5.5/high   ./               shared repo
● tests    waiting    worktree  gpt-5.5/high   ../pi/agent-tests          session def456
◼ docs     stopped    worktree  gpt-5.5/high   ../pi/agent-docs           resumable
✖ ui       crashed    worktree  gpt-5.5/high   ../pi/agent-ui             resumable
```

Implémentation avec :

```ts
ctx.ui.setWidget("parallel-agents", lines);
```

### Overlay interactif

Ajouter un raccourci, par exemple `ctrl+alt+a`, ouvrant un overlay TUI :

```text
┌ Parallel agents ─────────────────────────────┐
│ [1] api      running                         │
│ [2] tests    waiting for answer              │
│ [3] docs     done                            │
├ api output ──────────────────────────────────┤
│ ... streaming output tail ...                │
├ steer api ───────────────────────────────────┤
│ > focus only on public API compatibility     │
└ enter steer • ctrl+enter queue • tab switch • esc close ─┘
```

L’input de l’overlay appelle la même primitive que les tools : `message_parallel_agent`. Il peut envoyer un message `steer` ou ajouter une question dans la queue du sous-agent sélectionné :

```json
{"mode": "steer", "message": "..."}
{"mode": "queue", "message": "..."}
```

## Questions des sous-agents à l’utilisateur

En mode RPC, lorsqu’une extension dans un sous-agent appelle :

```ts
ctx.ui.input(...)
ctx.ui.select(...)
ctx.ui.confirm(...)
ctx.ui.editor(...)
```

Pi émet un event :

```json
{
  "type": "extension_ui_request",
  "method": "input",
  "id": "..."
}
```

Le parent intercepte cet event et l’affiche dans l’espace TUI du sous-agent.

Exemple :

```text
api asks:
Should I change the public route names?

[answer editor]
```

Puis le parent renvoie au processus RPC du sous-agent :

```json
{ "type": "extension_ui_response", "id": "...", "value": "..." }
```

## Messagerie entre agents

L’extension expose une primitive unique pour envoyer un message à un agent ou à l’agent principal :

```ts
message_parallel_agent({
  target: "api", // agentId ou "main"
  message: "Peux-tu vérifier si ce changement casse la compatibilité publique ?",
  mode: "steer", // "steer" | "queue" | "consult"
  expectAnswer: true,
  thinking: "xhigh" // optionnel, surtout utile pour mode="consult"
});
```

Et une primitive unique pour répondre à une question :

```ts
reply_parallel_question({
  questionId: "...",
  answer: "...",
  summary: "...",
  files: ["..."]
});
```

Commandes TUI équivalentes :

```text
/agents-steer <id> <message>              # message_parallel_agent(mode="steer")
/agents-ask <id> --mode steer <question>  # message_parallel_agent(mode="steer", expectAnswer=true)
/agents-ask <id> --mode queue <question>  # message_parallel_agent(mode="queue", expectAnswer=true)
/agents-consult <id> <question>           # message_parallel_agent(mode="consult", thinking="xhigh")
```

### Sous-agent vers agent principal

Un sous-agent pose une question au parent avec :

```ts
message_parallel_agent({
  target: "main",
  message: "Should I preserve backwards compatibility for /v1/users?",
  mode: "queue",
  expectAnswer: true
});
```

Le parent crée un `questionId`, injecte un message visible dans la session principale, puis le main agent répond via `reply_parallel_question`. La réponse est ensuite transmise au sous-agent demandeur.

### Agent principal vers sous-agent

L’agent principal peut choisir le mode de livraison :

- `steer` : oriente volontairement le sous-agent source ;
- `queue` : ajoute une vraie question/tâche au contexte du sous-agent source ;
- `consult` : interroge un clone jetable sans modifier le contexte source.

Comportement `mode = "steer"` :

1. si le sous-agent est en cours d’exécution, envoyer une commande RPC `steer` ;
2. si le sous-agent est idle mais son processus RPC est vivant, envoyer un `prompt` immédiat ;
3. si le sous-agent est `stopped` ou `crashed`, refuser le steer et proposer `queue` ou `/agents-resume <id>`.

Comportement `mode = "queue"` :

1. ajouter la question dans une file FIFO persistée par sous-agent ;
2. si le processus RPC est vivant et occupé, envoyer la question via `follow_up` ou la garder côté parent jusqu’à la fin du tour courant ;
3. si le processus RPC est idle, envoyer la prochaine question en `prompt` ;
4. si le processus est arrêté, conserver la question et la livrer automatiquement à la reprise ;
5. marquer la question `pending`, `delivering`, `delivered`, puis `answered` quand `reply_parallel_question` est reçu.

### Consultation éphémère sans pollution de contexte

Le mode `consult` sert aux questions qui ne doivent pas orienter le sous-agent source ni polluer son contexte. Il est disponible uniquement pour les sous-agents `workspaceMode = "worktree"`. En mode `current`, il doit être refusé, car un clone jetable ne peut pas garantir l’isolation de fichiers depuis le repo courant partagé.

Le tool appelle un script dédié, par exemple :

```bash
scripts/consult-subagent-clone.sh \
  --agent-id <id> \
  --question "<question>" \
  --thinking xhigh
```

La question est passée comme un seul argument `argv`, pas comme un chemin de fichier. Pour éviter les problèmes de quoting ou d’injection shell, l’extension doit appeler le script avec une API de type `spawn`/`execFile` et `shell: false`, jamais par concaténation dans une commande shell :

```ts
spawn(scriptPath, [
  "--agent-id", agentId,
  "--question", question,
  "--thinking", "xhigh"
], { shell: false })
```

Le script doit lire la valeur exacte de `--question`, refuser les octets NUL, appliquer une limite de taille raisonnable, et ne jamais faire `eval` ni réinterpréter la question comme du shell.

Flux `consult` :

1. attendre que le sous-agent source atteigne un point sûr (`turn_end` ou `agent_end`) ;
2. créer un clone temporaire du sous-agent à partir de sa session Pi et de son worktree ;
3. réutiliser la même configuration que la source (`provider`, `model`, tools, skills, extensions utiles), mais forcer `thinking = "xhigh"` par défaut ;
4. lancer un Pi RPC temporaire dans le worktree clone, avec le jeu de tools lecture seule ;
5. envoyer la question au clone avec une consigne stricte : répondre à la question, ne pas orienter la source, ne pas modifier les fichiers sauf autorisation explicite ;
6. récupérer la réponse via `reply_parallel_question` avec un `questionId` marqué comme consultation ;
7. arrêter le Pi RPC temporaire ;
8. supprimer le worktree temporaire, la branche temporaire et la session temporaire, sauf mode debug explicite ;
9. retourner la réponse à l’agent principal.

La question n’est jamais envoyée au sous-agent source. Elle n’apparaît donc ni dans sa queue, ni dans son historique de session, ni dans son contexte LLM. Le parent peut journaliser le résultat de consultation dans sa propre session et/ou dans SQLite, mais pas dans la session du sous-agent consulté.

### Persistance et livraison des questions

La queue ne doit jamais être seulement en mémoire. La source de vérité doit être un fichier SQLite partagé par l’agent principal et les sous-agents.

Option recommandée : utiliser `pi-tasks` comme couche de queue durable, car il fournit déjà :

- un stockage SQLite ;
- des listes ordonnées FIFO ;
- des statuts persistants ;
- des claims atomiques via `task_claims.claim_next` ;
- une reprise après crash via `release_expired` ;
- une surface de tools Pi/MCP déjà disponible.

Le script d’amorçage doit forcer un chemin absolu commun pour éviter qu’un worktree utilise sa propre base relative :

```bash
export PI_TASKS_DB_PATH="<repoRoot>/.pi/parallel-agents/tasks.sqlite"
```

Même base SQLite + mêmes `list_id` = queues partagées entre session principale, worktrees, agents en mode `current`, et éventuels clients MCP.

Organisation proposée dans `pi-tasks` :

```text
scope_type: workspace
scope_key: <repoRoot>
visibility: shared
list_id: parallel-agent-questions:<parent-session-id>:<agent-id>
```

Chaque sous-agent possède une liste de questions. Chaque question est une task :

```json
{
  "id": "q-123",
  "list_id": "parallel-agent-questions:main-session:api",
  "title": "Question for api: compatibilité publique",
  "description": "Payload JSON: agentId, mode, question, createdAt, expectedAnswer",
  "notes": "deliveryStatus=pending; rpcCommand=null; deliveredAt=null",
  "status": "todo"
}
```

Mapping entre le protocole parallel-agents et `pi-tasks` :

| État logique | `pi-tasks.status` | Détail                                        |
| ------------ | ----------------- | --------------------------------------------- |
| `pending`    | `todo`            | question créée, pas encore livrée             |
| `delivering` | `in_progress`     | question claimée par le dispatcher parent     |
| `delivered`  | `blocked`         | RPC accepté, attente de `reply_parallel_question` |
| `answered`   | `done`            | réponse stockée dans `outcome`                |
| `canceled`   | `canceled`        | question annulée                              |

Flux durable avec `pi-tasks` :

1. création de question : `task_items.create` avec `id = questionId`, `status = todo`, et payload dans `description`/`notes` ;
2. tentative de livraison : le dispatcher appelle `task_claims.claim_next` sur la liste du sous-agent ;
3. si une task est claimée, envoyer la question au sous-agent via `steer`, `follow_up` ou `prompt` selon le mode et l’état RPC ;
4. quand RPC accepte la commande, `task_items.update` passe la task en `blocked` avec `notes.deliveryStatus = delivered` ;
5. quand `reply_parallel_question` arrive, `task_items.update` passe la task en `done` et écrit la réponse dans `outcome` ;
6. si l’agent principal crashe en `in_progress`, le claim expire puis `task_claims.release_expired` remet la task en `todo`, donc elle redevient livrable.

Au démarrage ou redémarrage de l’agent principal, l’extension :

1. ouvre la même base via `PI_TASKS_DB_PATH` ;
2. retrouve les listes `parallel-agent-questions:*` du `repoRoot` ;
3. appelle `task_claims.release_expired` ;
4. relit les tasks `todo`, `in_progress`, `blocked`, `done` ;
5. reconstruit les queues en mémoire depuis SQLite ;
6. relivre uniquement les tasks `todo`.

Les tasks `blocked` représentent des questions déjà livrées mais sans réponse. Elles ne sont pas relivrées automatiquement, sauf commande explicite de retry ou si le parent détecte que la livraison RPC n’a jamais réellement été acceptée.

Le `questionId` rend la livraison idempotente : si une question est envoyée deux fois après un crash entre l’appel RPC et l’écriture de l’état `blocked`, le parent déduplique les réponses par `questionId` et ne marque la task `done` qu’une seule fois.

Le parent injecte ensuite la réponse dans la session principale sous forme de message visible, par exemple :

```text
Sub-agent api answered question q-123:
"Oui, le changement casse /v1/users si on ne garde pas l’alias."
```

## Cycle de vie : arrêt et reprise

L’agent principal doit pouvoir contrôler chaque enfant à tout moment.

### Arrêt d’un agent enfant

Commande côté main agent :

```text
/agents-stop <id>
```

Comportement :

1. `control_parallel_agent({ action: "stop" })` relit l’agent dans SQLite ;
2. si l’extension possède encore le transport RPC et que l’enfant travaille, envoyer `abort` ;
3. attendre une fin propre du tour courant si possible, puis fermer le transport RPC ;
4. appeler `scripts/stop-parallel-agent.sh` avec `--agent-id`, `--pid` et `--state-db` ;
5. le script termine le processus enfant si nécessaire (`SIGTERM`, puis `SIGKILL` en dernier recours) ;
6. le script écrit `status = "stopped"`, `pid = null` et `updated_at` dans SQLite ;
7. conserver son `workspaceMode`, `accessMode`, `cwd`, `worktreePath`, `branchName`, `sessionId`, `sessionFile`, `provider`, `model` et `thinking`.

Arrêter un agent ne doit jamais supprimer son worktree éventuel ni sa session Pi.

### Reprise d’un agent enfant

Commande côté main agent :

```text
/agents-resume <id>
```

Comportement :

1. `control_parallel_agent({ action: "resume" })` appelle `scripts/start-parallel-agent.sh` ;
2. le script relit les métadonnées persistées de l’enfant dans SQLite ;
3. rappeler `scripts/start-parallel-agent.sh` avec `--resume-session <session-file-or-id>`, `--workspace-mode`, `--access-mode`, `--cwd <cwd>`, `--provider`, `--model`, `--thinking` et `--state-db` ;
4. relancer Pi RPC dans le même workspace avec la session sauvegardée ;
5. récupérer le nouveau `pid` et l’état courant via `get_state` ;
6. écrire `status = "running"` ou `"waiting"` dans SQLite ;
7. permettre ensuite au parent d’envoyer un `steer`, un `follow_up` ou un nouveau prompt.

En cas de crash ou de fermeture inattendue du processus enfant, le parent appelle `parallel-agent-state.sh` pour écrire `status = "crashed"`, mais garde l’agent reprenable tant que `sessionFile` et `cwd` existent.

## Erreurs et reprise

Règles simples :

- toutes les écritures SQLite se font en transaction et par upsert idempotent sur `agent_id` ;
- si la création du worktree réussit mais le lancement Pi échoue, garder le worktree, écrire `status = "crashed"` et `last_error` ;
- si Pi démarre mais ne retourne pas `sessionId`/`sessionFile`, arrêter le processus, garder les fichiers et écrire `status = "crashed"` ;
- si le parent crashe pendant un lancement, au redémarrage il relit les agents `starting` trop anciens, vérifie le `pid` et passe l’agent en `waiting` si le RPC répond, sinon en `crashed` ;
- si un processus enfant sort sans arrêt demandé, écrire `status = "crashed"` ;
- si une question est `delivered` mais sans réponse, ne pas la relivrer automatiquement ; proposer une action de retry explicite ;
- ne jamais supprimer automatiquement un worktree, une branche ou une session après erreur.

## Gestion des résultats

Chaque sous-agent produit :

- un `workspaceMode` (`worktree` ou `current`) ;
- un `cwd` effectif ;
- une branche git et un worktree si `workspaceMode = "worktree"` ;
- aucune branche/worktree dédié si `workspaceMode = "current"` ;
- une session Pi persistée (`sessionId`, `sessionFile`) ;
- le modèle et le niveau de thinking utilisés ;
- les questions/réponses échangées avec l’agent principal ;
- un résumé final ;
- un diff ;
- les tests exécutés ;
- son statut final.

Ces informations sont écrites dans SQLite par `parallel-agent-state.sh`. Les tools ne doivent pas reconstruire l’état depuis des fichiers temporaires si la base contient déjà l’information.

L’extension expose les commandes TUI suivantes :

```text
/agents
/agents-open <id>
/agents-steer <id> <message>
/agents-ask <id> --mode steer|queue <question>
/agents-consult <id> <question>
/agents-stop <id>
/agents-resume <id>
/agents-defaults [--model <model>] [--thinking <level>]
/agents-summary
/agents-clean
```

Tools exposés au main agent :

```ts
launch_parallel_agents(...);
message_parallel_agent({ target, message, mode: "steer" | "queue" | "consult", expectAnswer? });
reply_parallel_question({ questionId, answer, summary?, files? });
get_parallel_agents({ agentId?, include?: ["status", "queues", "results", "summary", "diff", "logs"] });
control_parallel_agent({ action: "stop" | "resume" | "set_defaults" | "refresh" | "mark_done" | "clean", agentId?, ... });
```

Tools exposés aux sous-agents par défaut :

```ts
message_parallel_agent({ target: "main", message, mode: "queue", expectAnswer? });
reply_parallel_question({ questionId, answer, summary?, files? });
get_parallel_agents({ agentId?, include?: ["status", "queues"] });
```

Les sous-agents ne reçoivent pas `launch_parallel_agents` ni `control_parallel_agent` par défaut.

Implémentation des commandes :

| Commande | Tool interne |
| --- | --- |
| `/agents`, `/agents-open`, `/agents-summary` | `get_parallel_agents` |
| `/agents-steer`, `/agents-ask`, `/agents-consult` | `message_parallel_agent` |
| `/agents-stop`, `/agents-resume`, `/agents-defaults` | `control_parallel_agent` |
| `/agents-clean` | `control_parallel_agent` |

`/agents-summary` utilise la lecture suivante, directement depuis SQLite :

```ts
get_parallel_agents({ include: ["status", "results", "summary"] });
```

`control_parallel_agent({ action: "refresh" })` vérifie les `pid`, interroge `get_state` quand le RPC répond, puis met SQLite à jour via `parallel-agent-state.sh`.

`control_parallel_agent({ action: "mark_done" })` écrit le résumé final, les tests et `status = "done"` dans SQLite via `parallel-agent-state.sh`.

`/agents-clean` passe par `control_parallel_agent` et doit rester conservateur par défaut :

```ts
control_parallel_agent({
  action: "clean",
  agentId: "api",
  removeWorktree: true,
  removeBranch: false,
  removeSession: false,
  force: false
});
```

Règles de sécurité pour `clean` :

- ne jamais supprimer une branche sans confirmation explicite ;
- ne jamais supprimer une session sans option explicite ;
- marquer l’agent `cleaned` ou supprimer sa ligne uniquement si l’utilisateur demande de ne pas garder l’historique ;
- refuser un worktree dirty sauf `force: true` ;
- accepter aussi un scope global, par exemple `scope: "done"`, pour nettoyer plusieurs agents terminés.

Le tool `get_parallel_agents()` retourne une synthèse :

```text
api:
- workspaceMode: worktree
- accessMode: write
- cwd: ../pi/agent-api-refactor
- branch: agent-api-refactor
- worktree: ../pi/agent-api-refactor
- model: gpt-5.5
- thinking: high
- sessionId: abc123
- sessionFile: /Users/.../.pi/agent/sessions/...jsonl
- status: done
- summary: ...
- changed files: ...

triage:
- workspaceMode: current
- accessMode: read_only
- cwd: /path/to/repo
- branch: current checkout
- worktree: none
- model: gpt-5.5
- thinking: high
- sessionId: def456
- sessionFile: /Users/.../.pi/agent/sessions/...jsonl
- status: done
- summary: ...
- changed files: ...
```

## Découpage en versions

### Version 1 — lancement, état, lecture

Objectif : lancer des agents et les observer de manière fiable.

1. extension Pi `parallel-agents.ts` ;
2. scripts `start-parallel-agent.sh` et `parallel-agent-state.sh` ;
3. base SQLite `state.sqlite` avec tables `agents`, `agent_events`, `settings` ;
4. tool `launch_parallel_agents` ;
5. tool `get_parallel_agents` ;
6. commandes `/agents`, `/agents-open`, `/agents-summary` ;
7. configuration par défaut `model = "gpt-5.5"`, `thinking = "high"` ;
8. support `workspaceMode = "worktree"` avec création de worktree dans `../pi/<worktree-name>` ;
9. naming agent appelé par le script, avec le modèle du sous-agent, `thinking = "off"` et `--no-tools` ;
10. support `workspaceMode = "current"` en `accessMode = "read_only"` par défaut ;
11. lancement Pi RPC avec commandes vérifiées (`prompt`, `get_state`, `set_thinking_level`) ;
12. récupération et persistance de `sessionId`/`sessionFile` ;
13. widget TUI minimal avec statut, workspace, modèle/thinking et session.

### Version 2 — contrôle et messagerie durable

Objectif : piloter les agents après lancement.

1. scripts `stop-parallel-agent.sh` et reprise via `start-parallel-agent.sh --resume-session` ;
2. tool `control_parallel_agent` avec `stop`, `resume`, `set_defaults`, `refresh`, `mark_done`, `clean` ;
3. commandes `/agents-stop`, `/agents-resume`, `/agents-defaults`, `/agents-clean` ;
4. statuts SQLite complets : `starting`, `running`, `waiting`, `stopped`, `crashed`, `done`, `cleaned` ;
5. gestion simple des erreurs et reprise après crash ;
6. base `PI_TASKS_DB_PATH` partagée pour les queues de questions ;
7. intégration `pi-tasks` pour stocker les questions FIFO ;
8. tool `message_parallel_agent` en modes `steer` et `queue` ;
9. tool `reply_parallel_question` ;
10. commandes `/agents-steer` et `/agents-ask` ;
11. bridge `extension_ui_request` / `extension_ui_response` pour les questions utilisateur ;
12. overlay TUI simple pour lire le tail et envoyer `steer`/`queue`.

### Version 3 — consultation isolée et UX avancée

Objectif : ajouter les capacités avancées sans complexifier le socle.

1. mode `consult` dans `message_parallel_agent` ;
2. script `consult-subagent-clone.sh` ;
3. clone temporaire de worktree/session avec `thinking = "xhigh"` ;
4. refus du consult pour `workspaceMode = "current"` ;
5. nettoyage automatique des clones temporaires sauf debug ;
6. overlay TUI complet multi-agents ;
7. retry explicite des questions bloquées ;
8. review assistée des résultats ;
9. durcissement des garde-fous `current/write`.

## Décision d’architecture

Ne pas forker la session Pi principale.

Préférer :

- un agent principal orchestrateur ;
- des scripts shell comme frontière claire de création, reprise, arrêt, nettoyage et mise à jour d’état ;
- une base SQLite `state.sqlite` comme source de vérité des agents, écrite par les scripts ;
- un naming agent Pi appelé par le script, avec le modèle du sous-agent mais sans thinking ;
- une configuration explicite `model`/`thinking` des sous-agents, avec défaut `gpt-5.5`/`high` ;
- N sous-agents isolés dans leurs worktrees par défaut ;
- un mode opt-in sans worktree, en lecture seule par défaut, pour lancer un sous-agent directement dans le repo courant ;
- une session Pi persistée par sous-agent ;
- une base SQLite `tasks.sqlite` pour l’état durable des queues ;
- `pi-tasks` comme implémentation privilégiée des files FIFO de questions ;
- un mode `consult` dans `message_parallel_agent` pour interroger un clone jetable d’un agent worktree sans polluer le contexte source ;
- une communication explicite via RPC et tools bridge, dans les deux sens : sous-agent vers principal et principal vers sous-agent.

Cette approche est plus robuste, plus facile à tuer/reprendre, et évite les collisions de fichiers dans le mode par défaut. Le mode sans worktree est volontairement explicite et limité à la lecture seule par défaut, car il partage le checkout courant.
