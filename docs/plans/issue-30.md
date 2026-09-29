# Issue 30 — espace administrateur

Objectif livré : quatre écrans #29 bilingues, décisions atomiques, historique durable,
justificatifs privés et emails Mailpit. Hors périmètre : formulaires, upload,
claims privés, allowlists par issuer, gestion générale des admins, qualification production.

## Base et isolation

Worktree `issue/30-admin` à `.data/xcs-admin30`, base `ee39ba5` du chantier
`.data/xcs-integration`. Les modifications #27 non commitées ont été copiées dans
ce worktree (instantané local dans `.data/issue27-baseline.patch`), sans modification
du chantier source. La migration 0004 d'auth précède la nouvelle migration 0005.
Le checkout extérieur ancien n'est pas la base fonctionnelle du portail.
Aucun commit, push ni changement de branche du chantier source.

## Jalons terminés

1. Lecture #25/#27/#29/ADR0004, isolation et interface commune #27.
2. Décisions, audit, notifications, documents, rôles DB et bootstrap.
3. Quatre écrans Nuxt UI, français/anglais et états d'erreur.
4. PostgreSQL réel, Mailpit, navigateur, typage/lint/build et régressions.
5. Documentation de déploiement/reprise et revue finale.

## Architecture et corrections issues des vérifications

Aucune seconde authentification : export du contrôle CSRF #27 et garde admin
via le contexte serveur. Pools xcs_app (auth), xcs_admin_app (admin) et xcs_notifier
(email) distincts; xcs_admin est déjà le compte opérateur PostgreSQL.
Aucune dépendance à l'indexeur ni transaction XRPL pour une décision.
Double clic/reprise protégé par clé par auteur; concurrence par révision et verrou.
SMTP ambigu => statut uncertain, jamais renvoi automatique.

La revue a corrigé la pagination lorsque la dernière candidature d'une page est
traitée et l'identification de l'auteur sans display_name. Les tests SMTP ont
confirmé qu'une erreur Nodemailer CONN peut survenir après DATA : seul un refus
SMTP explicite ou un échec DNS/connect prouvé permet une reprise ordinaire.

Le démarrage de l'image a révélé que pnpm deploy retire des liens de dépendances
tracées par Nitro. Dockerfile.node recopie désormais la sortie autonome après deploy.
Le test avant correction échouait sur @noble/hashes ; le démarrage et les parcours
Docker ci-dessous réussissent après correction, sans dépendance supplémentaire.
Mailpit possède un bridge UI dédié pour que Docker publie effectivement son port
loopback ; le worker reste sur les réseaux internes uniquement.

## Vérifications du 23 septembre 2026

| Contrôle                                                                                     | Résultat                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`                                                                | Réussis ; nouveau helper runtime également typé et linté.                                                                                                         |
| `pnpm test`                                                                                  | Réussi : core14, SDK36, CLI9, DB61, indexeur212, web600 tests ; suites externes séparées.                                                                         |
| `pnpm build`                                                                                 | Réussi, y compris le worker compilé.                                                                                                                              |
| `pnpm test:postgres` sur cluster Docker isolé                                                | 42 DB,13 indexeur,22 web réussis ; navigateur runtime opt-in séparé.                                                                                              |
| `XCS_ADMIN_RUNTIME_TEST=1 … vitest run test/admin-postgres.integration.test.ts` avec Mailpit | 10 réussis : vraie base, SMTP reçu, panne/reprise, serveur compilé HTTPS, quatre écrans, décision navigateur et révocation.                                       |
| `pnpm test:runtime`                                                                          | 2 réussis : SSR/publication publique avec base réelle.                                                                                                            |
| `XCS_E2E_PORT=3130 … playwright test e2e/admin.spec.ts`                                      | 8 réussis : états UI avec API simulée, dont FR/EN, conflit, session expirée, droits, documents et pagination.                                                     |
| Suite navigateur générale                                                                    | 43 réussis,1 échec CSP hérité décrit ci-dessous. Les parcours découverte/wallet existants réussissent avec adaptateurs synthétiques.                              |
| Images Docker DB et web                                                                      | Construites ; stack séparée, secrets montés, UID node, racine read-only. Session réelle, document depuis volume privé, décision et notification Mailpit vérifiés. |
| Compose quatre overlays + tous profils                                                       | Rendu et isolation vérifiés ; Mailpit démarré et joignable uniquement sur le port UI loopback publié.                                                             |
| `sh ops/ci/test-node-entrypoint.sh`                                                          | Réussi.                                                                                                                                                           |
| `git diff --check`                                                                           | Réussi.                                                                                                                                                           |
| `pnpm format:check`                                                                          | Seul échec : fichier préexistant docs/issue-25-plan.md. Les fichiers de cette livraison passent.                                                                  |

L'échec navigateur général est dans `e2e/security.spec.ts` : l'assertion attend
`form-action 'self'`, tandis que le nuxt.config copié de #27 ajoute déjà
`https://account.xrpl.in`. Le même écart existe dans le chantier source ; #30 ne
modifie ni cette politique ni l'assertion. Le formatage de docs/issue-25-plan.md
échoue également sur le contenu HEAD inchangé. Ces écarts ne sont pas masqués.

Les tests ne constituent ni une connexion réelle à XRP Identity, ni des sessions
utilisateurs des maquettes, ni une vérification avec une extension wallet réelle.
Le navigateur runtime utilise un certificat synthétique limité à la clé publique
de ce test, sans modification de confiance système. Les tests TLS/SMTP/DB utilisent
des données synthétiques, jamais de données de production.

## Livraison et retour arrière

Consulter [le runbook](../runbooks/admin.md). Intégrer #27 et #30 ensemble,
appliquer0004 puis0005 et les droits minimaux avant activation. Conserver toutes les
données lors d'un retour arrière applicatif ; arrêter le worker et inspecter les
envois incertains avant reprise. Les services de validation sont isolés des autres
terminaux et les volumes sont durables.
