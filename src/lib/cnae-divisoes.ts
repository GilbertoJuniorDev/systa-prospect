// Divisões (2 primeiros dígitos) da CNAE 2.3 — 87 divisões, nomes oficiais.
// Fonte: IBGE/CONCLA, estrutura detalhada da CNAE 2.3 (https://concla.ibge.gov.br).
// Lista estática: a tabela "Cnae" só guarda subclasses (7 dígitos), então as divisões
// não existem no banco. Divisões sem atividades na base são filtradas na rota.

export interface CnaeDivisao {
  codigo: string;
  descricao: string;
}

export const CNAE_DIVISOES: ReadonlyArray<CnaeDivisao> = [
  { codigo: '01', descricao: 'Agricultura, pecuária e serviços relacionados' },
  { codigo: '02', descricao: 'Produção florestal' },
  { codigo: '03', descricao: 'Pesca e aquicultura' },
  { codigo: '05', descricao: 'Extração de carvão mineral' },
  { codigo: '06', descricao: 'Extração de petróleo e gás natural' },
  { codigo: '07', descricao: 'Extração de minerais metálicos' },
  { codigo: '08', descricao: 'Extração de minerais não-metálicos' },
  { codigo: '09', descricao: 'Atividades de apoio à extração de minerais' },
  { codigo: '10', descricao: 'Fabricação de produtos alimentícios' },
  { codigo: '11', descricao: 'Fabricação de bebidas' },
  { codigo: '12', descricao: 'Fabricação de produtos do fumo' },
  { codigo: '13', descricao: 'Fabricação de produtos têxteis' },
  { codigo: '14', descricao: 'Confecção de artigos do vestuário e acessórios' },
  {
    codigo: '15',
    descricao:
      'Preparação de couros e fabricação de artefatos de couro, artigos para viagem e calçados',
  },
  { codigo: '16', descricao: 'Fabricação de produtos de madeira' },
  { codigo: '17', descricao: 'Fabricação de celulose, papel e produtos de papel' },
  { codigo: '18', descricao: 'Impressão e reprodução de gravações' },
  {
    codigo: '19',
    descricao: 'Fabricação de coque, de produtos derivados do petróleo e de biocombustíveis',
  },
  { codigo: '20', descricao: 'Fabricação de produtos químicos' },
  { codigo: '21', descricao: 'Fabricação de produtos farmoquímicos e farmacêuticos' },
  { codigo: '22', descricao: 'Fabricação de produtos de borracha e de material plástico' },
  { codigo: '23', descricao: 'Fabricação de produtos de minerais não-metálicos' },
  { codigo: '24', descricao: 'Metalurgia' },
  { codigo: '25', descricao: 'Fabricação de produtos de metal, exceto máquinas e equipamentos' },
  {
    codigo: '26',
    descricao: 'Fabricação de equipamentos de informática, produtos eletrônicos e ópticos',
  },
  { codigo: '27', descricao: 'Fabricação de máquinas, aparelhos e materiais elétricos' },
  { codigo: '28', descricao: 'Fabricação de máquinas e equipamentos' },
  { codigo: '29', descricao: 'Fabricação de veículos automotores, reboques e carrocerias' },
  {
    codigo: '30',
    descricao: 'Fabricação de outros equipamentos de transporte, exceto veículos automotores',
  },
  { codigo: '31', descricao: 'Fabricação de móveis' },
  { codigo: '32', descricao: 'Fabricação de produtos diversos' },
  { codigo: '33', descricao: 'Manutenção, reparação e instalação de máquinas e equipamentos' },
  { codigo: '35', descricao: 'Eletricidade, gás e outras utilidades' },
  { codigo: '36', descricao: 'Captação, tratamento e distribuição de água' },
  { codigo: '37', descricao: 'Esgoto e atividades relacionadas' },
  {
    codigo: '38',
    descricao: 'Coleta, tratamento e disposição de resíduos; recuperação de materiais',
  },
  { codigo: '39', descricao: 'Descontaminação e outros serviços de gestão de resíduos' },
  { codigo: '41', descricao: 'Construção de edifícios' },
  { codigo: '42', descricao: 'Obras de infraestrutura' },
  { codigo: '43', descricao: 'Serviços especializados para construção' },
  { codigo: '45', descricao: 'Comércio e reparação de veículos automotores e motocicletas' },
  { codigo: '46', descricao: 'Comércio por atacado, exceto veículos automotores e motocicletas' },
  { codigo: '47', descricao: 'Comércio varejista' },
  { codigo: '49', descricao: 'Transporte terrestre' },
  { codigo: '50', descricao: 'Transporte aquaviário' },
  { codigo: '51', descricao: 'Transporte aéreo' },
  { codigo: '52', descricao: 'Armazenamento e atividades auxiliares dos transportes' },
  { codigo: '53', descricao: 'Correio e outras atividades de entrega' },
  { codigo: '55', descricao: 'Alojamento' },
  { codigo: '56', descricao: 'Alimentação' },
  { codigo: '58', descricao: 'Edição e edição integrada à impressão' },
  {
    codigo: '59',
    descricao:
      'Atividades cinematográficas, produção de vídeos e de programas de televisão; gravação de som e edição de música',
  },
  { codigo: '60', descricao: 'Atividades de rádio e de televisão' },
  { codigo: '61', descricao: 'Telecomunicações' },
  { codigo: '62', descricao: 'Atividades dos serviços de tecnologia da informação' },
  { codigo: '63', descricao: 'Atividades de prestação de serviços de informação' },
  { codigo: '64', descricao: 'Atividades de serviços financeiros' },
  { codigo: '65', descricao: 'Seguros, resseguros, previdência complementar e planos de saúde' },
  {
    codigo: '66',
    descricao:
      'Atividades auxiliares dos serviços financeiros, seguros, previdência complementar e planos de saúde',
  },
  { codigo: '68', descricao: 'Atividades imobiliárias' },
  { codigo: '69', descricao: 'Atividades jurídicas, de contabilidade e de auditoria' },
  {
    codigo: '70',
    descricao: 'Atividades de sedes de empresas e de consultoria em gestão empresarial',
  },
  { codigo: '71', descricao: 'Serviços de arquitetura e engenharia; testes e análises técnicas' },
  { codigo: '72', descricao: 'Pesquisa e desenvolvimento científico' },
  { codigo: '73', descricao: 'Publicidade e pesquisa de mercado' },
  { codigo: '74', descricao: 'Outras atividades profissionais, científicas e técnicas' },
  { codigo: '75', descricao: 'Atividades veterinárias' },
  {
    codigo: '77',
    descricao: 'Aluguéis não-imobiliários e gestão de ativos intangíveis não-financeiros',
  },
  { codigo: '78', descricao: 'Seleção, agenciamento e locação de mão-de-obra' },
  { codigo: '79', descricao: 'Agências de viagens, operadores turísticos e serviços de reservas' },
  { codigo: '80', descricao: 'Atividades de vigilância, segurança e investigação' },
  { codigo: '81', descricao: 'Serviços para edifícios e atividades paisagísticas' },
  {
    codigo: '82',
    descricao:
      'Serviços de escritório, de apoio administrativo e outros serviços prestados principalmente às empresas',
  },
  { codigo: '84', descricao: 'Administração pública, defesa e seguridade social' },
  { codigo: '85', descricao: 'Educação' },
  { codigo: '86', descricao: 'Atividades de atenção à saúde humana' },
  {
    codigo: '87',
    descricao:
      'Atividades de atenção à saúde humana integradas com assistência social, prestadas em residências coletivas e particulares',
  },
  { codigo: '88', descricao: 'Serviços de assistência social sem alojamento' },
  { codigo: '90', descricao: 'Atividades artísticas, criativas e de espetáculos' },
  { codigo: '91', descricao: 'Atividades ligadas ao patrimônio cultural e ambiental' },
  { codigo: '92', descricao: 'Atividades de exploração de jogos de azar e apostas' },
  { codigo: '93', descricao: 'Atividades esportivas e de recreação e lazer' },
  { codigo: '94', descricao: 'Atividades de organizações associativas' },
  {
    codigo: '95',
    descricao:
      'Reparação e manutenção de equipamentos de informática e comunicação e de objetos pessoais e domésticos',
  },
  { codigo: '96', descricao: 'Outras atividades de serviços pessoais' },
  { codigo: '97', descricao: 'Serviços domésticos' },
  { codigo: '99', descricao: 'Organismos internacionais e outras instituições extraterritoriais' },
];

export const CODIGOS_DIVISAO: ReadonlySet<string> = new Set(CNAE_DIVISOES.map((d) => d.codigo));
