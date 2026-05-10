# Plan — Agents parallèles dans Pi

## Objectif

Ajouter à Pi une capacité de lancement de plusieurs sous-agents en parallèle depuis un prompt principal.

Chaque sous-agent doit :

- créer son propre `git worktree` ;
- travailler dans `../pi/<branch-name>` où `..` est le dossier parent de la racine du projet courant ;
- utiliser le même harness Pi que l’agent principal ;
- avoir un espace dédié dans la TUI ;
- pouvoir poser des questions à l’utilisateur ;
- pouvoir poser des questions à l’agent principal ;
- pouvoir être steeré par l’utilisateur pendant son exécution.

## Architecture proposée

Construire une extension Pi appelée par exemple `parallel-agents.ts`.

Cette extension orchestre des sous-agents Pi lancés en mode RPC :

```bash
pi --mode rpc --provider <same-provider> --model <same-model>
```

Chaque sous-agent est un vrai processus Pi indépendant, avec :

- son propre `cwd`, pointant vers son worktree ;
- le même modèle que l’agent principal ;
- le même niveau de thinking ;
- les mêmes credentials Pi ;
- les mêmes tools de base ;
- les mêmes skills/prompts/extensions utiles.

Le choix du mode RPC permet :

- une isolation propre ;
- le vrai runtime Pi ;
- la réception des events de streaming ;
- l’envoi de messages `prompt`, `steer`, `follow_up`, `abort` ;
- le routage du protocole `extension_ui_request` vers l’interface TUI principale.

## Création des worktrees

Pour chaque sous-agent :

1. Déterminer la racine git :

   ```bash
   git rev-parse --show-toplevel
   ```

2. Calculer le dossier cible :

   ```text
   repoRoot = racine git du projet courant
   parent = dirname(repoRoot)
   worktreeBase = path.join(parent, "pi")
   worktreePath = path.join(worktreeBase, branchName)
   ```

3. Créer le worktree :

   ```bash
   git worktree add -b <branch-name> ../pi/<branch-name> HEAD
   ```

4. Gérer les collisions de noms :

   ```text
   feature-auth   -> ../pi/feature-auth
   feature-auth-2 -> si feature-auth existe déjà
   ```

Les noms de branches doivent être sanitizés.

## Déclenchement depuis le prompt

L’extension expose un tool au main agent :

```ts
launch_parallel_agents({
  agents: [
    {
      name: "api",
      branchName: "agent-api-refactor",
      prompt: "Explore/refactor the API layer..."
    },
    {
      name: "tests",
      branchName: "agent-tests",
      prompt: "Add regression tests..."
    }
  ]
})
```

Exemple d’usage utilisateur :

```text
Lance 3 agents en parallèle : un pour les tests, un pour l’UI, un pour la doc.
```

Le main agent appelle le tool, puis l’extension :

1. crée les branches ;
2. crée les worktrees ;
3. démarre les processus Pi RPC ;
4. envoie le prompt initial à chaque sous-agent ;
5. retourne les ids des sous-agents au main agent.

## Interface TUI

### Widget permanent

Afficher un widget au-dessus de l’éditeur :

```text
Parallel agents
● api      running   ../pi/agent-api-refactor
● tests    waiting   ../pi/agent-tests
✖ docs     failed    ../pi/agent-docs
```

Implémentation avec :

```ts
ctx.ui.setWidget("parallel-agents", lines)
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
└ enter steer • tab switch • esc close ─────────┘
```

L’input de l’overlay envoie un message `steer` au sous-agent sélectionné :

```json
{"type": "steer", "message": "..."}
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
{"type": "extension_ui_response", "id": "...", "value": "..."}
```

## Questions des sous-agents à l’agent principal

Créer un bridge explicite.

Chaque sous-agent reçoit un tool :

```ts
ask_main_agent({
  question: "Should I preserve backwards compatibility for /v1/users?"
})
```

Quand ce tool est appelé :

1. le parent crée une question en attente ;
2. le parent injecte dans la session principale un message du type :

   ```text
   Sub-agent api asks:

   "Should I preserve backwards compatibility for /v1/users?"

   Réponds avec le tool reply_to_subagent.
   ```

3. le main agent répond via :

   ```ts
   reply_to_subagent({
     questionId: "...",
     answer: "Yes, preserve backwards compatibility."
   })
   ```

4. le parent transmet la réponse au sous-agent.

## Gestion des résultats

Chaque sous-agent produit :

- une branche git ;
- un worktree ;
- un résumé final ;
- un diff ;
- les tests exécutés ;
- son statut final.

L’extension expose des commandes :

```text
/agents
/agents-open <id>
/agents-steer <id> <message>
/agents-stop <id>
/agents-summary
/agents-merge <id>
/agents-clean
```

Et un tool côté main agent :

```ts
collect_subagent_results()
```

qui retourne une synthèse :

```text
api:
- branch: agent-api-refactor
- worktree: ../pi/agent-api-refactor
- status: done
- summary: ...
- changed files: ...

tests:
- branch: agent-tests
- worktree: ../pi/agent-tests
- status: done
- summary: ...
- changed files: ...
```

## MVP

Construire d’abord :

1. extension Pi `parallel-agents.ts` ;
2. tool `launch_parallel_agents` ;
3. création des worktrees dans `../pi/<branch-name>` ;
4. lancement de Pi RPC par sous-agent ;
5. streaming des events dans un widget TUI ;
6. commande `/agents` pour afficher l’état ;
7. commande `/agents-steer <id> <message>`.

Ensuite :

8. overlay TUI interactif complet ;
9. bridge `ask_user` via `extension_ui_request` ;
10. bridge `ask_main_agent` / `reply_to_subagent` ;
11. review/merge assisté des résultats.

## Décision d’architecture

Ne pas forker la session Pi principale.

Préférer :

- un agent principal orchestrateur ;
- N sous-agents isolés dans leurs worktrees ;
- une communication explicite via RPC et tools bridge.

Cette approche est plus robuste, plus facile à tuer/reprendre, et évite les collisions de fichiers.
