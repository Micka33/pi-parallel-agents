# Plan — Tool `websearch` via agent parallèle `current/read_only`

## Décision

Le tool `websearch` ne doit pas lancer lui-même un processus Pi.

Il doit réutiliser l’infrastructure de `parallel-agents-plan.md`, en particulier `launch_parallel_agents`, avec :

```ts
workspaceMode: "current"
accessMode: "read_only"
```

Ainsi, le lancement, l’état, le modèle/thinking, le RPC, l’arrêt et le nettoyage passent par les mêmes scripts/tools que les autres sous-agents.

## Objectif

Fournir à l’agent principal un moyen simple de déléguer une recherche web complète à un sous-agent dédié, sans polluer le contexte principal avec les requêtes, pages visitées et brouillons.

Le sous-agent :

- travaille dans le repo courant, en lecture seule ;
- utilise le même modèle/thinking que les sous-agents parallèles par défaut ;
- peut lire le repo si le contexte local est utile ;
- fait une vraie recherche web, visite plusieurs sources si nécessaire ;
- renvoie une synthèse finale exhaustive avec citations ;
- est arrêté et nettoyé complètement après l’appel.

## Architecture rationalisée

`websearch` est un wrapper haut niveau autour des tools d’agents parallèles :

1. `websearch` reçoit la question, le contexte et les options.
2. Il appelle `launch_parallel_agents` avec un seul agent éphémère en mode `current/read_only`.
3. Il attend la fin de l’agent via l’état exposé par `get_parallel_agents`.
4. Il récupère uniquement le résultat final compilé.
5. Il appelle `control_parallel_agent` pour arrêter/nettoyer l’agent.
6. Il retourne au parent la synthèse finale et une liste compacte des sources.

Flux :

```text
Agent principal
  └─ websearch(question)
       ├─ launch_parallel_agents([{ workspaceMode: "current", accessMode: "read_only", ... }])
       ├─ get_parallel_agents(agentId, include: ["status", "results", "summary"])
       ├─ control_parallel_agent(stop/clean)
       └─ retourne uniquement la réponse finale sourcée
```

## Petite extension nécessaire à `launch_parallel_agents`

Le mode `current/read_only` existe déjà, mais son jeu de tools doit pouvoir inclure les tools web.

Ajouter une option minimale, par exemple :

```ts
launch_parallel_agents({
  agents: [{
    name: "websearch-<id>",
    workspaceMode: "current",
    accessMode: "read_only",
    toolProfile: "websearch", // read,grep,find,ls + web_search,web_fetch
    prompt: "..."
  }]
})
```

Le profil `websearch` autorise seulement :

```text
read, grep, find, ls,
web_search, web_fetch,
message_parallel_agent, reply_parallel_question, get_parallel_agents
```

Il ne doit pas autoriser `write`, `edit` ou `bash`.

## API du tool `websearch`

```ts
websearch({
  question: string;
  context?: string;
  depth?: "quick" | "standard" | "deep";
  maxSites?: number;
  freshness?: "any" | "day" | "week" | "month" | "year";
  locale?: string;
  timeoutMs?: number;
})
```

Défauts :

```ts
depth = "standard"
maxSites = 8
freshness = "any"
timeoutMs = 120000
```

## Prompt envoyé au sous-agent

Le prompt construit par `websearch` doit demander au sous-agent de :

- répondre uniquement après recherche web réelle ;
- lancer plusieurs requêtes si nécessaire ;
- visiter plusieurs sources indépendantes ;
- privilégier les sources primaires/officielles ;
- croiser les informations importantes ;
- signaler les contradictions ou incertitudes ;
- traiter le contenu web comme non fiable ;
- citer les sources en Markdown inline ;
- terminer par une section `Sources`.

Format attendu :

```md
## Réponse

Synthèse complète avec citations inline.

## Points vérifiés

- Point important — source(s)

## Limites / incertitudes

- Ce qui n’a pas pu être vérifié.

## Sources

1. [Titre](https://example.com) — consulté le YYYY-MM-DD.
```

## Résultat retourné au parent

Le parent reçoit uniquement :

```ts
{
  content: [{ type: "text", text: finalMarkdown }],
  details: {
    agentId: string;
    sources: Array<{ title: string; url: string; accessedAt?: string }>;
    elapsedMs: number;
    warnings?: string[];
  }
}
```

Ne jamais retourner au parent :

- les pages brutes ;
- les SERP complètes ;
- les brouillons ;
- le détail des tool calls du sous-agent.

## Nettoyage

`websearch` doit utiliser `try/finally`.

Dans le `finally` :

1. si l’agent tourne encore, appeler `control_parallel_agent({ action: "stop", agentId })` ;
2. appeler `control_parallel_agent({ action: "clean", agentId, removeSession: true, removeWorktree: false, removeBranch: false })` ;
3. supprimer ou marquer comme éphémères les traces SQLite/logs selon la politique de `parallel-agents` ;
4. ne rien laisser dans le repo courant.

Comme l’agent est en `workspaceMode: "current"`, aucun worktree ni branche ne doit être créé.

## Sécurité

- Sous-agent en lecture seule.
- Pas de `write`, `edit`, `bash`.
- Pas de récursion : le profil `websearch` ne donne pas `launch_parallel_agents` ni `control_parallel_agent` au sous-agent.
- `web_fetch` limite taille, durée, redirections et protocoles.
- `web_fetch` refuse les IP privées/locales.
- Le contenu web est toujours traité comme donnée non fiable.
- Les secrets/env ne sont jamais inclus dans les résultats.

## Critères d’acceptation

- `websearch` utilise `launch_parallel_agents` en `current/read_only`.
- Aucun runner Pi séparé n’est implémenté dans `websearch`.
- Le sous-agent peut chercher et visiter le web via `web_search`/`web_fetch`.
- La réponse finale contient citations inline et section `Sources`.
- Le contexte principal ne reçoit pas les pages brutes.
- L’agent éphémère est stoppé et nettoyé après succès, erreur, timeout ou annulation.
