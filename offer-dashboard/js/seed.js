/* Dati iniziali: catalogo prodotti, catalogo task e offerte d'esempio (come da schizzo). */
window.SEED = {
  version: 1,
  /* Modello dati della pratica: l'input generale del processo. I campi si definiscono/importano nella pagina Catalogo. */
  practice: {
    fields: [
      { name: 'pratica.id', type: 'string', required: true, description: 'Identificativo della pratica' },
      { name: 'pratica.documenti[].tipo', type: 'string', required: true, description: 'Tipo del documento caricato dal cliente' },
      { name: 'pratica.documenti[].nome', type: 'string', required: true, description: 'Nome del file' },
      { name: 'cliente.codiceFiscale', type: 'string', required: true, description: '' },
      { name: 'cliente.email', type: 'string', required: true, description: '' },
      { name: 'cliente.documento.tipo', type: 'string', required: true, description: 'Tipo di documento d\'identità' },
      { name: 'cliente.documento.numero', type: 'string', required: true, description: '' },
      { name: 'cliente.documento.scadenza', type: 'date', required: true, description: '' },
      { name: 'prodotti.TIM.msisdn', type: 'string', required: false, description: 'Numero di linea (solo offerte con TIM)' },
      { name: 'cliente.giaVerificato', type: 'boolean', required: false, description: 'Cliente già verificato in precedenza (si possono saltare i controlli)' },
      { name: 'pratica.spedizioni[].destinatario.cap', type: 'string', required: false, description: 'CAP di consegna di ogni spedizione' },
      { name: 'pratica.spedizioni[].colli[].peso', type: 'number', required: false, description: 'Peso (kg) di ogni collo di ogni spedizione' }
    ]
  },
  products: [
    { id: 'CONTO', name: 'Conto', category: 'Banking', description: 'Conto corrente online' },
    { id: 'EVO', name: 'Evo', category: 'Banking', description: 'Carta di debito evoluta' },
    { id: 'LIBMIN', name: 'Lib Min', category: 'Banking', description: 'Libretto minori' },
    { id: 'TIM', name: 'TIM', category: 'Telco', description: 'Offerta telco partner' }
  ],
  tasks: [
    {
      id: 'VERIFICA_DOCUMENTO', name: 'Verifica documento', description: 'Verifica validità del documento di identità',
      type: 'sync', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      api: { method: 'POST', path: '/documenti/v1/verifica' },
      inputs: [
        { name: 'tipoDocumento', source: 'cliente.documento.tipo', required: true },
        { name: 'numeroDocumento', source: 'cliente.documento.numero', required: true },
        { name: 'scadenza', source: 'cliente.documento.scadenza', required: true }
      ],
      outputs: [{ name: 'documentoValido', description: 'true/false' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 1, intervalSec: 10 }, koQueue: 'BO_DOCUMENTI', callbackTopic: '' }
    },
    {
      id: 'ORACOLO', name: 'Oracolo', description: 'Verifiche antifrode/antiriciclaggio sul cliente. Una chiamata per N prodotti.',
      type: 'sync', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN'],
      api: { method: 'POST', path: '/oracolo/v1/check' },
      inputs: [
        { name: 'codiceFiscale', source: 'cliente.codiceFiscale', required: true },
        { name: 'documento', source: 'cliente.documento.numero', required: true },
        { name: 'prodotti[]', type: 'array', source: 'offerta.prodotti', required: true },
        { name: 'prodotti[].id', source: 'prodotto.id', required: true }
      ],
      outputs: [
        { name: 'esitoOracolo', description: 'OK/KO per prodotto' }, { name: 'scoreRischio', description: '0-100' },
        { name: 'risultati[].prodotto', description: 'Prodotto a cui si riferisce il risultato' },
        { name: 'risultati[].esito', description: 'OK/KO del prodotto' },
        { name: 'risultati[].score', type: 'integer', description: 'Punteggio di rischio del prodotto' }
      ],
      productResults: { list: 'risultati', productField: 'prodotto', outcomeField: 'esito', ok: ['OK'], koTask: [] },
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: true, ko: true },
      defaults: { retry: { count: 3, intervalSec: 30 }, koQueue: 'BO_ANTIFRODE', callbackTopic: '' }
    },
    {
      id: 'ORACOLO_2', name: 'Oracolo 2', description: 'Verifiche specifiche partner telco',
      type: 'sync', callMode: 'perProduct',
      compatibleProducts: ['TIM'],
      api: { method: 'POST', path: '/partner/tim/v1/oracolo' },
      inputs: [
        { name: 'codiceFiscale', source: 'cliente.codiceFiscale', required: true },
        { name: 'msisdn', source: 'prodotti.TIM.msisdn', required: false }
      ],
      outputs: [{ name: 'esitoOracolo2', description: 'OK/KO' }],
      outcomes: ['OK', 'KO'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 2, intervalSec: 60 }, koQueue: '', callbackTopic: '' }
    },
    {
      id: 'PREGIUDIZIEVOLI', name: 'Pregiudizievoli', description: 'Controllo presenza di pregiudizievoli/protesti',
      type: 'sync', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN'],
      api: { method: 'POST', path: '/pregiudizievoli/v1/check' },
      inputs: [
        { name: 'codiceFiscale', source: 'cliente.codiceFiscale', required: true },
        { name: 'scoreRischio', source: 'esiti.ORACOLO.scoreRischio', required: false }
      ],
      outputs: [{ name: 'presenzaPregiudizievoli', description: 'true/false' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: true },
      defaults: { retry: { count: 2, intervalSec: 30 }, koQueue: 'BO_CREDITO', callbackTopic: '' }
    },
    {
      id: 'CRIBIS', name: 'Cribis', description: 'Verifica se il cliente è "in rosso" (solo Conto)',
      type: 'sync', callMode: 'perProduct',
      compatibleProducts: ['CONTO'],
      api: { method: 'GET', path: '/cribis/v1/rating/{codiceFiscale}' },
      inputs: [{ name: 'codiceFiscale', source: 'cliente.codiceFiscale', required: true }],
      outputs: [{ name: 'rating', description: 'Classe di rischio' }],
      outcomes: ['OK', 'KO'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 2, intervalSec: 30 }, koQueue: '', callbackTopic: '' }
    },
    {
      id: 'PRESA_IN_CARICO_BO', name: 'Presa in carico BO', description: 'Invio pratica al back office con presa in carico e callback su topic',
      type: 'async', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      api: { method: 'POST', path: '/backoffice/v1/pratiche' },
      inputs: [
        { name: 'idPratica', source: 'pratica.id', required: true },
        { name: 'documenti[]', type: 'array', source: 'pratica.documenti[]', required: true },
        { name: 'documenti[].tipo', source: '@.tipo', required: true },
        { name: 'documenti[].nome', source: '@.nome', required: true }
      ],
      outputs: [{ name: 'esitoBO', description: 'OK/KO' }, { name: 'operatore', description: 'Operatore BO' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: true },
      defaults: { retry: { count: 0, intervalSec: 0 }, koQueue: 'BO_RILAVORAZIONE', callbackTopic: 'bo.pratiche.esiti' }
    },
    {
      id: 'STAMPA_CONTRATTI', name: 'Stampa contratti', description: 'Generazione PDF contrattuali, sempre con gli stessi parametri',
      type: 'sync', callMode: 'perProduct',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      api: { method: 'POST', path: '/contratti/v1/stampa' },
      inputs: [
        { name: 'idPratica', source: 'pratica.id', required: true },
        { name: 'codiceProdotto', source: 'prodotto.id', required: true }
      ],
      outputs: [{ name: 'idDocumento', description: 'Id documento archiviato' }],
      outcomes: ['OK', 'KO'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 3, intervalSec: 10 }, koQueue: '', callbackTopic: '' }
    },
    {
      id: 'ATTIVAZIONE_BANCARIA', name: 'Attivazione prodotto bancario', description: 'Attivazione su core banking',
      type: 'sync', callMode: 'perProduct',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN'],
      api: { method: 'POST', path: '/corebanking/v1/attivazioni' },
      inputs: [
        { name: 'idPratica', source: 'pratica.id', required: true },
        { name: 'codiceProdotto', source: 'prodotto.id', required: true }
      ],
      outputs: [{ name: 'idRapporto', description: 'Id rapporto attivato' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 3, intervalSec: 60 }, koQueue: 'BO_ATTIVAZIONI', callbackTopic: '' }
    },
    {
      id: 'ATTIVAZIONE_TIM', name: 'Attivazione TIM', description: 'Attivazione presso partner, esito via callback (minuti/giorni)',
      type: 'async', callMode: 'perProduct',
      compatibleProducts: ['TIM'],
      api: { method: 'POST', path: '/partner/tim/v1/attivazioni' },
      inputs: [
        { name: 'idPratica', source: 'pratica.id', required: true },
        { name: 'msisdn', source: 'prodotti.TIM.msisdn', required: false }
      ],
      outputs: [{ name: 'idLinea', description: 'Id linea attivata' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 1, intervalSec: 300 }, koQueue: 'BO_PARTNER', callbackTopic: 'partner.tim.attivazioni' }
    },
    {
      id: 'COMUNICAZIONI', name: 'Invio comunicazioni', description: 'Mail/SMS al cliente (benvenuto, esito, ...)',
      type: 'sync', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      api: { method: 'POST', path: '/comunicazioni/v1/invio' },
      inputs: [
        { name: 'email', source: 'cliente.email', required: true },
        { name: 'template', source: '', required: true }
      ],
      outputs: [{ name: 'idComunicazione', description: '' }],
      outcomes: ['OK', 'KO'],
      extensions: { request: true, ko: false },
      defaults: { retry: { count: 3, intervalSec: 60 }, koQueue: '', callbackTopic: '' }
    },
    {
      id: 'SPEDIZIONE_KIT', name: 'Spedizione kit', description: 'Spedizione dei kit con l\'elenco delle spedizioni (e dei colli) della pratica; risponde con un esito per prodotto e il tracking di ogni spedizione',
      type: 'sync', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      api: { method: 'POST', path: '/logistica/v1/spedizioni' },
      inputs: [
        { name: 'idPratica', source: 'pratica.id', required: true },
        { name: 'prodotti[]', type: 'array', source: 'offerta.prodotti', required: true },
        { name: 'prodotti[].id', source: 'prodotto.id', required: true },
        { name: 'spedizioni[]', type: 'array', source: 'pratica.spedizioni[]', required: true },
        { name: 'spedizioni[].cap', source: '@.destinatario.cap', required: true },
        { name: 'spedizioni[].colli[]', type: 'array', source: '@.colli[]', required: false },
        { name: 'spedizioni[].colli[].peso', source: '@.peso', required: false }
      ],
      outputs: [
        { name: 'risultati[].prodotto', description: 'Prodotto a cui si riferisce il risultato' },
        { name: 'risultati[].esito', description: 'OK, KO o MANUALE (serve un intervento)' },
        { name: 'spedizioni[].tracking', description: 'Codice di tracking di ogni spedizione' }
      ],
      productResults: { list: 'risultati', productField: 'prodotto', outcomeField: 'esito', ok: ['OK'], koTask: ['MANUALE'] },
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 2, intervalSec: 60 }, koQueue: 'BO_LOGISTICA', callbackTopic: '' }
    }
  ],
  offers: [
    {
      id: 'OFF_BUNDLE', name: 'Bundle Conto + Evo + Lib Min + TIM',
      description: 'Offerta d\'esempio ricostruita dallo schizzo',
      products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      blocks: [
        { id: 'B_ORACOLO', taskId: 'ORACOLO', products: ['CONTO', 'EVO', 'LIBMIN'], dependsOn: [] },
        { id: 'B_PREGIUDIZIEVOLI', taskId: 'PREGIUDIZIEVOLI', products: ['CONTO', 'EVO', 'LIBMIN'], dependsOn: ['B_ORACOLO'] },
        { id: 'B_ORACOLO2', taskId: 'ORACOLO_2', products: ['TIM'], dependsOn: [] },
        { id: 'B_CRIBIS', taskId: 'CRIBIS', products: ['CONTO'], dependsOn: ['G_PRE_1'] },
        { id: 'B_BO', taskId: 'PRESA_IN_CARICO_BO', products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], dependsOn: ['G_VER_1'] },
        { id: 'B_ATT_BANCA', taskId: 'ATTIVAZIONE_BANCARIA', products: ['CONTO', 'EVO', 'LIBMIN'], dependsOn: ['G_BO_1'] },
        { id: 'B_ATT_TIM', taskId: 'ATTIVAZIONE_TIM', products: ['TIM'], dependsOn: ['G_BO_1'] },
        { id: 'B_WELCOME', taskId: 'COMUNICAZIONI', products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], dependsOn: ['G_ATT_1'],
          config: { inputMapping: { template: 'WELCOME_KIT' } } }
      ],
      gates: [
        { id: 'G_PRE_1', dependsOn: ['B_PREGIUDIZIEVOLI', 'B_ORACOLO2'], note: 'Oracolo 2 può rispondere in ritardo', rules: [{ type: 'DONT_WAIT', blockId: 'B_ORACOLO2' }, { type: 'ONLY_OK' }] },
        { id: 'G_VER_1', dependsOn: ['B_CRIBIS'], note: '', rules: [{ type: 'ONLY_OK' }] },
        { id: 'G_BO_1', dependsOn: ['B_BO'], note: '', rules: [{ type: 'STOP_ON_KO', products: [] }] },
        { id: 'G_ATT_1', dependsOn: ['B_ATT_BANCA', 'B_ATT_TIM'], note: 'Le comunicazioni partono anche se un\'attivazione fallisce', rules: [{ type: 'CONTINUE_ON_KO' }] }
      ]
    },
    {
      id: 'OFF_CONTO', name: 'Solo Conto',
      description: 'Offerta mono-prodotto',
      products: ['CONTO'],
      blocks: [
        { id: 'B_C_DOC', taskId: 'VERIFICA_DOCUMENTO', products: ['CONTO'], dependsOn: [] },
        { id: 'B_C_ORACOLO', taskId: 'ORACOLO', products: ['CONTO'], dependsOn: ['B_C_DOC'] },
        { id: 'B_C_CRIBIS', taskId: 'CRIBIS', products: ['CONTO'], dependsOn: ['G_C_1'] },
        { id: 'B_C_ATT', taskId: 'ATTIVAZIONE_BANCARIA', products: ['CONTO'], dependsOn: ['B_C_CRIBIS'] }
      ],
      gates: [
        { id: 'G_C_1', dependsOn: ['B_C_ORACOLO'], note: '', rules: [{ type: 'STOP_ON_KO', products: [] }] }
      ]
    },
    {
      id: 'OFF_DEMO', name: 'Demo',
      description: 'Offerta dimostrativa del grafo libero: sequenze, rami paralleli impilati, gate di un solo ramo e gate join, blocchi con «SE …», liste in input (un elemento per prodotto, spedizioni e colli dalla pratica) e in output (risultati per prodotto, letti con [@] e []), condizioni su liste, ritorno indietro, salto in avanti e stop dai gate, KO con task, Non attendere e callback asincrone. In simulazione compila i «Dati dello scenario» per far valere le condizioni.',
      products: ['CONTO', 'EVO', 'TIM'],
      blocks: [
        // Partenza: verifica documento, poi Oracolo (lista per prodotto) e Oracolo 2 di TIM in parallelo
        { id: 'B_D_DOC', taskId: 'VERIFICA_DOCUMENTO', products: ['CONTO', 'EVO', 'TIM'], dependsOn: [] },
        { id: 'B_D_ORACOLO', taskId: 'ORACOLO', products: ['CONTO', 'EVO'], dependsOn: ['B_D_DOC'] },
        { id: 'B_D_ORACOLO2', taskId: 'ORACOLO_2', products: ['TIM'], dependsOn: ['B_D_DOC'] },
        // Due rami separati dopo il gate: Cribis (condizionato dal punteggio letto con [@]) → Oracolo, con un gate solo per questo ramo;
        // Pregiudizievoli (condizionato dal tipo di documento) → avviso al cliente. I rami si riuniscono nel gate join G_D_VER.
        { id: 'B_D_CRIBIS', taskId: 'CRIBIS', products: ['CONTO'], dependsOn: ['G_D_PRE'],
          config: { when: { join: 'AND', clauses: [{ left: 'esiti.B_D_ORACOLO.risultati[@].score', op: '>=', value: '50' }] } } },
        { id: 'B_D_V_ORACOLO', taskId: 'ORACOLO', products: ['CONTO'], dependsOn: ['B_D_CRIBIS'] },
        { id: 'B_D_PREG', taskId: 'PREGIUDIZIEVOLI', products: ['CONTO', 'EVO'], dependsOn: ['G_D_PRE'],
          config: { when: { join: 'AND', clauses: [{ left: 'cliente.documento.tipo', op: '!=', value: 'CI' }] } } },
        { id: 'B_D_V_AVVISO', taskId: 'COMUNICAZIONI', products: ['CONTO', 'EVO'], dependsOn: ['B_D_PREG'],
          config: { inputMapping: { template: 'AVVISO_PREGIUDIZIEVOLI' } } },
        // BO: asincrono con callback, la lista dei documenti parte solo se ce ne sono (condizione su lista)
        { id: 'B_D_BO', taskId: 'PRESA_IN_CARICO_BO', products: ['CONTO', 'EVO', 'TIM'], dependsOn: ['G_D_VER'],
          config: { when: { join: 'AND', clauses: [{ left: 'pratica.documenti[]', op: 'countGt', value: '0' }] } } },
        { id: 'B_D_ATT_BANCA', taskId: 'ATTIVAZIONE_BANCARIA', products: ['CONTO', 'EVO'], dependsOn: ['G_D_BO'] },
        { id: 'B_D_ATT_TIM', taskId: 'ATTIVAZIONE_TIM', products: ['TIM'], dependsOn: ['G_D_BO'] },
        // Dopo le attivazioni: spedizione con liste, benvenuto per tutti e un avviso solo se l'attivazione TIM è in KO
        { id: 'B_D_SPED', taskId: 'SPEDIZIONE_KIT', products: ['CONTO', 'EVO', 'TIM'], dependsOn: ['G_D_ATT'] },
        { id: 'B_D_WELCOME', taskId: 'COMUNICAZIONI', products: ['CONTO', 'EVO', 'TIM'], dependsOn: ['G_D_ATT'],
          config: { inputMapping: { template: 'WELCOME_KIT' } } },
        { id: 'B_D_RITARDO', taskId: 'COMUNICAZIONI', products: ['TIM'], dependsOn: ['G_D_ATT'],
          config: { inputMapping: { template: 'TIM_RITARDO' }, when: { join: 'AND', clauses: [{ left: 'esito.B_D_ATT_TIM', op: '==', value: 'KO' }] } } }
      ],
      gates: [
        { id: 'G_D_PRE', dependsOn: ['B_D_ORACOLO', 'B_D_ORACOLO2'], note: 'Join: Oracolo 2 può rispondere in ritardo. Clienti già verificati: si saltano verticali e BO',
          rules: [{ type: 'DONT_WAIT', blockId: 'B_D_ORACOLO2' }, { type: 'ONLY_OK' },
            { type: 'ROUTE', to: 'G_D_BO', maxIterations: 3, onExceed: 'STOP', when: { join: 'AND', clauses: [{ left: 'cliente.giaVerificato', op: '==', value: 'true' }] } }] },
        { id: 'G_D_RA', dependsOn: ['B_D_V_ORACOLO'], note: 'Gate di un solo ramo (Cribis → Oracolo): qui escono i KO del ramo, l\'altro ramo non aspetta', rules: [{ type: 'ONLY_OK' }] },
        { id: 'G_D_VER', dependsOn: ['G_D_RA', 'B_D_V_AVVISO'], note: 'Join dei due rami. Se Cribis è KO si riparte dalla verifica documento (al massimo 2 volte)',
          rules: [{ type: 'ONLY_OK' }, { type: 'ROUTE', to: 'B_D_DOC', maxIterations: 2, onExceed: 'STOP', when: { join: 'AND', clauses: [{ left: 'esito.B_D_CRIBIS', op: '==', value: 'KO' }] } }] },
        { id: 'G_D_BO', dependsOn: ['B_D_BO'], note: 'Si ferma tutto se Oracolo ha dato KO a un prodotto',
          rules: [{ type: 'ROUTE', to: 'STOP', when: { join: 'AND', clauses: [{ left: 'esiti.B_D_ORACOLO.risultati[].esito', op: 'anyEq', value: 'KO' }] } }] },
        { id: 'G_D_ATT', dependsOn: ['B_D_ATT_BANCA', 'B_D_ATT_TIM'], note: 'Le comunicazioni partono anche se un\'attivazione fallisce', rules: [{ type: 'CONTINUE_ON_KO' }] }
      ]
    }
  ]
};
