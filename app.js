/* CapSup - logique partagée entre les pages */

const CapSup = {
  data: null,

  async loadData() {
    if (this.data) return this.data;
    const res = await fetch('data.json');
    this.data = await res.json();
    return this.data;
  },

  getById(id) {
    return (this.data || []).find(f => f.id === id);
  },

  selectivityBadge(item) {
    const map = {
      tres_selectif: { cls: 'badge-danger', label: 'Très sélective' },
      selectif: { cls: 'badge-high', label: 'Sélective' },
      moyen: { cls: 'badge-warn', label: 'Sélectivité moyenne' },
      peu_selectif: { cls: 'badge-ok', label: 'Peu sélective' },
      a_verifier: { cls: 'badge-neutral', label: 'Donnée à vérifier' }
    };
    const v = map[item.taux_acces_niveau] || map.a_verifier;
    return `<span class="badge-dot ${v.cls}">${v.label}</span>`;
  },

  costBadge(item) {
    const map = {
      faible: { cls: 'badge-ok', label: 'Coût faible' },
      variable: { cls: 'badge-warn', label: 'Coût variable' },
      eleve: { cls: 'badge-danger', label: 'Coût élevé' },
      a_verifier: { cls: 'badge-neutral', label: 'Coût à vérifier' }
    };
    const v = map[item.frais_niveau] || map.a_verifier;
    return `<span class="badge-dot ${v.cls}">${v.label}</span>`;
  },

  sourceTag(type) {
    const map = {
      officielle: 'Donnée officielle',
      calculée: 'Donnée calculée',
      qualitative: 'Donnée qualitative',
      a_verifier: 'Donnée à vérifier'
    };
    return map[type] || '';
  },

  /* Nombre de champs dont la source precise est connue : signale une fiche etayee. */
  sourcedBadge(item) {
    const n = Object.keys(item.fiabilite || {}).length;
    if (!n) return '';
    const label = n > 1 ? `${n} champs sourcés` : '1 champ sourcé';
    return `<span class="badge-dot badge-ok">${label}</span>`;
  },

  formationCard(item, opts = {}) {
    const compareUI = opts.compare === false ? '' : `
      <label class="compare-check">
        <input type="checkbox" class="compare-toggle" data-id="${item.id}">
        Comparer
      </label>`;
    return `
      <div class="formation-card" data-id="${item.id}">
        <span class="type-tag">${item.type}</span>
        <h3>${item.nom}</h3>
        <div class="etab">${item.etablissement} — ${item.ville}</div>
        <div class="meta-row">
          <span>${item.duree}</span>
          <span>${item.frais_scolarite}</span>
        </div>
        <div class="meta-row">
          ${this.selectivityBadge(item)}
          ${this.sourcedBadge(item)}
        </div>
        <div class="card-actions">
          <a class="btn btn-ghost btn-sm" href="formation.html?id=${item.id}">Voir la formation</a>
          ${compareUI}
        </div>
      </div>`;
  },

  escapeList(arr) {
    if (!arr || arr.length === 0) return 'Donnée non disponible';
    return arr.join(', ');
  }
};
