/* Dati iniziali: catalogo prodotti, catalogo task e offerta d'esempio (come da schizzo). */
window.SEED = {
  version: 1,
  steps: [
    { id: 'PRELIMINARI', name: 'Verifiche Preliminari' },
    { id: 'VERTICALI', name: 'Verifiche Verticali' },
    { id: 'BO', name: 'Verifiche BO' },
    { id: 'ATTIVAZIONI', name: 'Attivazioni' },
    { id: 'POST_ATTIVAZIONI', name: 'Post Attivazioni' }
  ],
  /* Modello dati della pratica: l'input generale del processo. I campi si definiscono/importano nella pagina Catalogo. */
  practice: {
    fields: [
      { name: 'pratica.id', type: 'string', required: true, description: 'Identificativo della pratica' },
      { name: 'pratica.documenti', type: 'array', required: true, description: 'Documenti caricati dal cliente' },
      { name: 'cliente.codiceFiscale', type: 'string', required: true, description: '' },
      { name: 'cliente.email', type: 'string', required: true, description: '' },
      { name: 'cliente.documento.tipo', type: 'string', required: true, description: 'Tipo di documento d\'identità' },
      { name: 'cliente.documento.numero', type: 'string', required: true, description: '' },
      { name: 'cliente.documento.scadenza', type: 'date', required: true, description: '' },
      { name: 'prodotti.TIM.msisdn', type: 'string', required: false, description: 'Numero di linea (solo offerte con TIM)' }
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
      type: 'sync', scope: 'common', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], allowedSteps: ['PRELIMINARI'],
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
      type: 'sync', scope: 'common', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN'], allowedSteps: ['PRELIMINARI', 'VERTICALI'],
      api: { method: 'POST', path: '/oracolo/v1/check' },
      inputs: [
        { name: 'codiceFiscale', source: 'cliente.codiceFiscale', required: true },
        { name: 'documento', source: 'cliente.documento.numero', required: true },
        { name: 'prodotti', source: 'offerta.prodotti', required: true }
      ],
      outputs: [{ name: 'esitoOracolo', description: 'OK/KO per prodotto' }, { name: 'scoreRischio', description: '0-100' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: true, ko: true },
      defaults: { retry: { count: 3, intervalSec: 30 }, koQueue: 'BO_ANTIFRODE', callbackTopic: '' }
    },
    {
      id: 'ORACOLO_2', name: 'Oracolo 2', description: 'Verifiche specifiche partner telco',
      type: 'sync', scope: 'vertical', callMode: 'perProduct',
      compatibleProducts: ['TIM'], allowedSteps: ['PRELIMINARI'],
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
      type: 'sync', scope: 'common', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN'], allowedSteps: ['PRELIMINARI', 'VERTICALI'],
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
      type: 'sync', scope: 'vertical', callMode: 'perProduct',
      compatibleProducts: ['CONTO'], allowedSteps: ['VERTICALI'],
      api: { method: 'GET', path: '/cribis/v1/rating/{codiceFiscale}' },
      inputs: [{ name: 'codiceFiscale', source: 'cliente.codiceFiscale', required: true }],
      outputs: [{ name: 'rating', description: 'Classe di rischio' }],
      outcomes: ['OK', 'KO'],
      extensions: { request: false, ko: false },
      defaults: { retry: { count: 2, intervalSec: 30 }, koQueue: '', callbackTopic: '' }
    },
    {
      id: 'PRESA_IN_CARICO_BO', name: 'Presa in carico BO', description: 'Invio pratica al back office con presa in carico e callback su topic',
      type: 'async', scope: 'common', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], allowedSteps: ['BO'],
      api: { method: 'POST', path: '/backoffice/v1/pratiche' },
      inputs: [
        { name: 'idPratica', source: 'pratica.id', required: true },
        { name: 'documenti', source: 'pratica.documenti', required: true }
      ],
      outputs: [{ name: 'esitoBO', description: 'OK/KO' }, { name: 'operatore', description: 'Operatore BO' }],
      outcomes: ['OK', 'KO', 'KO_TASK'],
      extensions: { request: false, ko: true },
      defaults: { retry: { count: 0, intervalSec: 0 }, koQueue: 'BO_RILAVORAZIONE', callbackTopic: 'bo.pratiche.esiti' }
    },
    {
      id: 'STAMPA_CONTRATTI', name: 'Stampa contratti', description: 'Generazione PDF contrattuali, sempre con gli stessi parametri',
      type: 'sync', scope: 'common', callMode: 'perProduct',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], allowedSteps: ['BO', 'ATTIVAZIONI'],
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
      type: 'sync', scope: 'common', callMode: 'perProduct',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN'], allowedSteps: ['ATTIVAZIONI'],
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
      type: 'async', scope: 'vertical', callMode: 'perProduct',
      compatibleProducts: ['TIM'], allowedSteps: ['ATTIVAZIONI'],
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
      type: 'sync', scope: 'common', callMode: 'perOffer',
      compatibleProducts: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], allowedSteps: [],
      api: { method: 'POST', path: '/comunicazioni/v1/invio' },
      inputs: [
        { name: 'email', source: 'cliente.email', required: true },
        { name: 'template', source: '', required: true }
      ],
      outputs: [{ name: 'idComunicazione', description: '' }],
      outcomes: ['OK', 'KO'],
      extensions: { request: true, ko: false },
      defaults: { retry: { count: 3, intervalSec: 60 }, koQueue: '', callbackTopic: '' }
    }
  ],
  offers: [
    {
      id: 'OFF_BUNDLE', name: 'Bundle Conto + Evo + Lib Min + TIM',
      description: 'Offerta d\'esempio ricostruita dallo schizzo',
      products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
      blocks: [
        { id: 'B_ORACOLO', taskId: 'ORACOLO', stepId: 'PRELIMINARI', products: ['CONTO', 'EVO', 'LIBMIN'], dependsOn: [] },
        { id: 'B_PREGIUDIZIEVOLI', taskId: 'PREGIUDIZIEVOLI', stepId: 'PRELIMINARI', products: ['CONTO', 'EVO', 'LIBMIN'], dependsOn: ['B_ORACOLO'] },
        { id: 'B_ORACOLO2', taskId: 'ORACOLO_2', stepId: 'PRELIMINARI', products: ['TIM'], dependsOn: [] },
        { id: 'B_CRIBIS', taskId: 'CRIBIS', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: [] },
        { id: 'B_BO', taskId: 'PRESA_IN_CARICO_BO', stepId: 'BO', products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], dependsOn: [] },
        { id: 'B_ATT_BANCA', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'ATTIVAZIONI', products: ['CONTO', 'EVO', 'LIBMIN'], dependsOn: [] },
        { id: 'B_ATT_TIM', taskId: 'ATTIVAZIONE_TIM', stepId: 'ATTIVAZIONI', products: ['TIM'], dependsOn: [] },
        { id: 'B_WELCOME', taskId: 'COMUNICAZIONI', stepId: 'POST_ATTIVAZIONI', products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'], dependsOn: [],
          config: { inputMapping: { template: 'WELCOME_KIT' } } }
      ],
      gates: [
        { id: 'G_PRE_1', afterStep: 'PRELIMINARI', note: 'Oracolo 2 può rispondere in ritardo', rules: [{ type: 'DONT_WAIT', blockId: 'B_ORACOLO2' }] },
        { id: 'G_PRE_2', afterStep: 'PRELIMINARI', note: '', rules: [{ type: 'ONLY_OK' }] },
        { id: 'G_VER_1', afterStep: 'VERTICALI', note: '', rules: [{ type: 'ONLY_OK' }] },
        { id: 'G_BO_1', afterStep: 'BO', note: '', rules: [{ type: 'STOP_ON_KO', products: [] }] },
        { id: 'G_ATT_1', afterStep: 'ATTIVAZIONI', note: 'Le comunicazioni partono anche se un\'attivazione fallisce', rules: [{ type: 'CONTINUE_ON_KO' }] }
      ]
    },
    {
      id: 'OFF_CONTO', name: 'Solo Conto',
      description: 'Offerta mono-prodotto',
      products: ['CONTO'],
      blocks: [
        { id: 'B_C_DOC', taskId: 'VERIFICA_DOCUMENTO', stepId: 'PRELIMINARI', products: ['CONTO'], dependsOn: [] },
        { id: 'B_C_ORACOLO', taskId: 'ORACOLO', stepId: 'PRELIMINARI', products: ['CONTO'], dependsOn: ['B_C_DOC'] },
        { id: 'B_C_CRIBIS', taskId: 'CRIBIS', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: [] },
        { id: 'B_C_ATT', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'ATTIVAZIONI', products: ['CONTO'], dependsOn: [] }
      ],
      gates: [
        { id: 'G_C_1', afterStep: 'PRELIMINARI', note: '', rules: [{ type: 'STOP_ON_KO', products: [] }] }
      ]
    }
  ]
};
