# Croc — comptes rendus dentaires vétérinaires

Outil web pour rédiger des comptes rendus dentaires clairs et illustrés pour les propriétaires de chiens, chats et lapins.

- **Odontogramme** par espèce (numérotation de Triadan modifiée) : chien 42 dents, chat 30, lapin 28.
- **Repères anatomiques** : en tête du compte rendu, l'illustration de la dentition de l'espèce et le rôle de chaque famille de dents ; dans le PDF, elle se cale dans la place libre de la première page.
- **Plusieurs constats par dent** (tartre, gingivite, parodontite, fracture, résorption…) avec intensité ou stade, et plusieurs soins.
- **Radiographies** : réglage luminosité/contraste, négatif, annotations ; une radio associée à une dent apparaît dans sa ligne du compte rendu.
- **Photos avant / après** avec comparateur à curseur.
- **Historique des patients** : visites regroupées par animal, nouvelle visite (les dents extraites sont reportées comme absentes).
- **Logo** : le logo HOPia figure par défaut en tête du compte rendu ; une clinique peut le remplacer par le sien dans « Clinique & vétérinaire ».
- **Export PDF** A4 et export/import du dossier en `.json` (images comprises).

## Lancer en local

Il faut Node 18 ou plus récent, sans dépendance à installer.

```bash
PORT=8765 node server.js
```

Puis ouvrir http://localhost:8765/index.html

## En ligne

Déployé sur Railway : https://croc-production.up.railway.app

Le `Dockerfile` lance `server.js` (Node), qui sert `index.html` et enregistre les comptes rendus dans `/data`, un volume Railway : ils survivent aux redéploiements. On y accède avec un mot de passe unique, celui de la variable `CROC_PASSWORD`. Pour redéployer :

```bash
railway up --service croc
```

## Accès

- Le site s'ouvre sur un écran de connexion qui demande le mot de passe défini dans la variable Railway `CROC_PASSWORD` (sans cette variable, le site est ouvert à tous).
- On reste connecté 30 jours sur l'appareil ; « Se déconnecter » en haut à droite.
- Changer `CROC_PASSWORD` dans Railway déconnecte tout le monde.
- Après 10 mauvais mots de passe, une adresse IP doit patienter un quart d'heure.

## Données

Les comptes rendus, leurs images et les informations de la clinique sont enregistrés sur le serveur (`DATA_DIR`, par défaut `./data`) : on les retrouve depuis n'importe quel appareil. À la première ouverture, les dossiers déjà enregistrés dans le navigateur y sont recopiés.

Si `index.html` est servi sans `server.js` (simple serveur de fichiers), le site revient à l'enregistrement dans le navigateur (IndexedDB).

Les polices viennent de Google Fonts ; l'export PDF charge html2canvas et jsPDF depuis cdnjs à la première utilisation.
