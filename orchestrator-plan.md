# Plan — Orchestration par architectures agentiques

## Objectif

Ajouter à l’extension Pi `pi-parallel-agents` une couche d’orchestration déclarative.

L’utilisateur doit pouvoir sélectionner une architecture agentique, puis l’agent principal doit savoir :

- quels types de sous-agents existent pour cette architecture ;
- quand les lancer ;
- lesquels peuvent tourner en parallèle ou doivent être chaînés ;
- avec quel rôle, quels outils, quel mode de workspace et quel prompt lancer chaque sous-agent ;
- comment agréger leurs résultats.

Cette logique doit être organisée dans des fichiers `.mdc` versionnables dans le projet, par exemple :

```text
.pi-parallel-agents/
└── architectures/
    └── <architecture-name>/
        ├── 00-scout.mdc
        ├── 10-planner.mdc
        ├── 20-worker.mdc
        └── 30-reviewer.mdc
```

Un fichier `.mdc` représente un type d’agent lançable dans l’architecture sélectionnée.

## Principe général

L’extension ne doit pas injecter toutes les architectures dans le contexte à chaque tour. Elle doit plutôt :

1. découvrir les architectures disponibles au démarrage ou au reload ;
2. exposer au modèle une consigne courte indiquant qu’une architecture peut être chargée ;
3. fournir un tool qui charge en contexte l’architecture sélectionnée au moment utile ;
4. forcer l’agent principal à appeler ce tool avant tout lancement de sous-agents orchestrés ;
5. utiliser les définitions `.mdc` chargées pour construire les appels à `launch_parallel_agents`.

Ainsi, le contexte reste léger tant qu’aucune orchestration n’est nécessaire, puis les prompts complets des agents sont chargés uniquement quand l’utilisateur choisit une architecture ou demande une tâche qui en dépend.

## Dossier des architectures

Racine projet proposée :

```text
<repoRoot>/.pi-parallel-agents/architectures/
```

Chaque sous-dossier est une architecture :

```text
.pi-parallel-agents/architectures/implementation-review/
├── 00-scout.mdc
├── 10-planner.mdc
├── 20-implementer.mdc
└── 30-reviewer.mdc
```

Règles MVP :

- seuls les fichiers `*.mdc` du dossier de l’architecture sont chargés ;
- le tri se fait par `order` dans le frontmatter, puis par nom de fichier ;
- le nom d’architecture est le nom du dossier ;
- l’identifiant d’agent vient de `id` dans le frontmatter, sinon du nom de fichier sans préfixe numérique ;
- les chemins sont résolus sous `.pi-parallel-agents/architectures` uniquement, sans traversée `..`.

## Format d’un fichier `.mdc`

Un `.mdc` contient :

1. un frontmatter YAML avec les métadonnées d’orchestration ;
2. un corps Markdown utilisé comme prompt système ou prompt de délégation du sous-agent.

Exemple :

```mdc
---
id: scout
label: Scout codebase
description: Explore le code et produit un contexte compressé sans modifier les fichiers.
phase: discovery
order: 10
when: À lancer au début d’une tâche d’implémentation ou quand le contexte du code est insuffisant.
parallel: true
requires: []
workspaceMode: current
accessMode: read_only
tools: [read, grep, find, ls, bash]
model: gpt-5.5
thinking: high
outputs:
  - cartographie des fichiers pertinents
  - risques et inconnues
  - recommandations pour le planner
---
Tu es un sous-agent Scout.

Mission : analyser le dépôt pour répondre à la tâche déléguée, sans modifier les fichiers.

Entrées disponibles :
- objectif utilisateur : {{user_goal}}
- contexte parent : {{parent_context}}
- résultats des agents précédents : {{previous_results}}

Retour attendu :
- résumé court ;
- fichiers importants avec justification ;
- points d’attention ;
- questions ouvertes.
```

Champs recommandés :

| Champ | Sens |
| --- | --- |
| `id` | Identifiant stable utilisé dans les appels de lancement. |
| `label` | Nom affiché dans la TUI. |
| `description` | Résumé court montré à l’agent principal. |
| `phase` | Phase logique : `discovery`, `planning`, `implementation`, `review`, etc. |
| `order` | Ordre par défaut dans un workflow séquentiel. |
| `when` | Conditions de déclenchement, écrites pour l’agent principal. |
| `parallel` | Si `true`, ce type peut être lancé en parallèle avec d’autres. |
| `requires` | Liste d’agents ou de phases à terminer avant lancement. |
| `workspaceMode` | `worktree` ou `current`. |
| `accessMode` | `read_only` ou `write`. |
| `tools` | Outils autorisés pour le sous-agent. |
| `model` | Modèle optionnel ; sinon défaut de l’extension. |
| `thinking` | Niveau de reasoning optionnel ; sinon défaut de l’extension. |
| `outputs` | Résultats attendus, utiles pour l’agrégation. |

## Tool de chargement du contexte d’orchestration

Nom proposé : `load_parallel_architecture`.

Rôle : charger en contexte l’architecture agentique sélectionnée, ou une partie de celle-ci, pour permettre à l’agent principal de décider quels sous-agents lancer et avec quels prompts.

Schema logique :

```ts
{
  architecture?: string;
  mode?: "index" | "summary" | "full" | "agents";
  agents?: string[];
  userGoal?: string;
  includePrompts?: boolean;
}
```

Comportement :

- `mode: "index"` liste les architectures disponibles sans charger les prompts complets ;
- `mode: "summary"` charge les métadonnées de tous les agents de l’architecture sélectionnée ;
- `mode: "full"` charge métadonnées et corps Markdown de tous les `.mdc` de l’architecture ;
- `mode: "agents"` charge uniquement les agents listés dans `agents` ;
- si `architecture` est omis, le tool utilise l’architecture sélectionnée par l’utilisateur ;
- si aucune architecture n’est sélectionnée, le tool retourne l’index et demande une sélection.

Le résultat retourné au modèle doit contenir :

```ts
{
  architecture: string;
  architectureRoot: string;
  agents: Array<{
    id: string;
    label: string;
    description: string;
    phase?: string;
    order: number;
    when?: string;
    parallel?: boolean;
    requires?: string[];
    workspaceMode?: "worktree" | "current";
    accessMode?: "read_only" | "write";
    tools?: string[];
    model?: string;
    thinking?: string;
    outputs?: string[];
    prompt?: string;
    sourcePath: string;
  }>;
  orchestrationGuidance: string;
}
```

`prompt` n’est inclus que pour `mode: "full"` ou `mode: "agents"` avec `includePrompts: true`.

## Injection dans le prompt système

L’extension doit utiliser `before_agent_start` pour ajouter une consigne courte, pas les prompts complets :

```text
## Parallel agent orchestration

Des architectures agentiques peuvent être disponibles dans `.pi-parallel-agents/architectures`.
Si l’utilisateur sélectionne ou demande une architecture agentique, appelle `load_parallel_architecture` avant de lancer des sous-agents.
Ne lance pas de sous-agent orchestré depuis ta mémoire : utilise les définitions `.mdc` chargées.
```

Si une architecture est déjà sélectionnée :

```text
Architecture agentique sélectionnée : implementation-review.
Appelle `load_parallel_architecture({ mode: "summary" })` pour décider des agents à utiliser, puis `mode: "agents"` pour charger les prompts nécessaires avant lancement.
```

Le tool doit aussi définir `promptSnippet` et `promptGuidelines` afin que le modèle sache quand l’utiliser.

## Sélection d’architecture

Deux entrées sont proposées :

- commande TUI `/parallel-architecture` : ouvre un `ctx.ui.select` avec les architectures découvertes ;
- tool `load_parallel_architecture` : accepte `architecture` pour charger explicitement une architecture donnée.

La sélection est stockée :

- en mémoire pour la session courante ;
- dans une entrée de session via `pi.appendEntry("parallel-architecture-selection", {...})` pour restauration ;
- optionnellement dans SQLite si l’on veut la retrouver dans l’état durable des sous-agents.

## Utilisation lors du lancement de sous-agents

Flux cible :

```text
Utilisateur sélectionne architecture A
  ↓
Agent principal reçoit une tâche compatible
  ↓
Agent principal appelle load_parallel_architecture({ mode: "summary" })
  ↓
Agent principal choisit les types d’agents nécessaires
  ↓
Agent principal appelle load_parallel_architecture({ mode: "agents", agents: [...] })
  ↓
Agent principal appelle launch_parallel_agents avec les prompts composés
```

La composition du prompt enfant doit combiner :

- le corps Markdown du `.mdc` ;
- la tâche déléguée ;
- le contexte utilisateur utile ;
- les résultats des agents précédents ;
- les contraintes runtime : workspace, accès, outils, modèle, thinking.

Exemple de payload vers `launch_parallel_agents` :

```ts
{
  architecture: "implementation-review",
  agents: [
    {
      type: "scout",
      displayName: "Scout codebase",
      promptTemplateSource: ".pi-parallel-agents/architectures/implementation-review/00-scout.mdc",
      prompt: "<corps mdc rendu avec variables>",
      workspaceMode: "current",
      accessMode: "read_only",
      tools: ["read", "grep", "find", "ls", "bash"],
      model: "gpt-5.5",
      thinking: "high"
    }
  ]
}
```

`launch_parallel_agents` doit enregistrer `architecture` et `agentType` dans SQLite pour faciliter l’affichage, la reprise et l’audit.

## Validation et sécurité

Les architectures projet sont contrôlées par le dépôt. Elles doivent être traitées comme du code non fiable.

Règles :

- ne charger que sous `.pi-parallel-agents/architectures` ;
- refuser les symlinks qui sortent de cette racine ;
- borner la taille totale chargée dans le contexte ;
- afficher le chemin source des `.mdc` chargés ;
- demander confirmation avant d’exécuter une architecture projet si l’option de sécurité est active ;
- valider `workspaceMode`, `accessMode`, `tools`, `model`, `thinking` ;
- refuser `accessMode: write` en `workspaceMode: current` sauf confirmation explicite ;
- ne jamais exécuter automatiquement une instruction d’un `.mdc` sans décision explicite de l’agent principal ou de l’utilisateur.

## MVP

1. Créer le loader de fichiers `.mdc` : découverte, parsing frontmatter, tri, validation.
2. Ajouter le tool `load_parallel_architecture` avec modes `index`, `summary`, `full`, `agents`.
3. Ajouter l’injection courte dans `before_agent_start`.
4. Ajouter la commande `/parallel-architecture` pour sélectionner l’architecture courante.
5. Adapter `launch_parallel_agents` pour accepter `architecture`, `agentType`, `promptTemplateSource`.
6. Ajouter un exemple d’architecture `implementation-review`.
7. Ajouter les garde-fous de sécurité minimum : chemins, taille, confirmation projet, validation des enums.

## Extension future

- Manifeste optionnel `architecture.mdc` pour décrire une stratégie globale d’architecture.
- Variables typées dans les prompts : `{{user_goal}}`, `{{parent_context}}`, `{{previous_results}}`, `{{repo_summary}}`.
- Recommandation automatique d’architecture selon la demande utilisateur.
- Mode dry-run qui produit un plan d’orchestration sans lancer d’agents.
- Validation statique des architectures avec un tool `validate_parallel_architecture`.
- Visualisation TUI du graphe d’agents, phases, dépendances et états.
