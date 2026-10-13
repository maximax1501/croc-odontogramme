# Croc — comptes rendus dentaires vétérinaires

Outil web pour rédiger des comptes rendus dentaires clairs et illustrés pour les propriétaires de chiens, chats et lapins.

- **Odontogramme** par espèce (numérotation de Triadan modifiée) : chien 42 dents, chat 30, lapin 28.
- **Plusieurs constats par dent** (tartre, gingivite, parodontite, fracture, résorption…) avec intensité ou stade, et plusieurs soins.
- **Radiographies** : réglage luminosité/contraste, négatif, annotations ; une radio associée à une dent apparaît dans sa ligne du compte rendu.
- **Photos avant / après** avec comparateur à curseur.
- **Historique des patients** : visites regroupées par animal, nouvelle visite (les dents extraites sont reportées comme absentes).
- **Export PDF** A4 et export/import du dossier en `.json` (images comprises).

## Lancer en local

Tout tient dans `index.html`, sans dépendance à installer.

```bash
python3 -m http.server 8765
```

Puis ouvrir http://localhost:8765/index.html

## Données

Dans cette version autonome, les dossiers sont enregistrés dans le navigateur (IndexedDB), sur l'appareil utilisé. Pensez à exporter régulièrement les comptes rendus importants.

Les polices viennent de Google Fonts ; l'export PDF charge html2canvas et jsPDF depuis cdnjs à la première utilisation.
