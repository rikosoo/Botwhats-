'use strict';

const { normalizar } = require('./nlu');

/**
 * Triagem de seguranca. O bot NAO avalia sintomas nem da conduta clinica —
 * ele so reconhece sinais de alarme para mandar a pessoa procurar
 * atendimento imediato e avisar a equipe do consultorio.
 */
const EMERGENCIA = [
  'dor no peito', 'dor forte no peito', 'aperto no peito', 'infarto', 'enfarte',
  'falta de ar', 'sem conseguir respirar', 'nao consigo respirar', 'sufocando',
  'desmaio', 'desmaiou', 'perdi a consciencia', 'convulsao', 'convulsionando',
  'avc', 'derrame', 'boca torta', 'formigamento de um lado', 'fraqueza de um lado',
  'sangramento intenso', 'sangrando muito', 'hemorragia', 'vomitando sangue',
  'me matar', 'suicidio', 'tirar a minha vida', 'nao quero mais viver',
  'atropelado', 'acidente grave', 'engasgado', 'overdose', 'intoxicacao',
  'bebe com febre alta', 'crianca nao acorda', 'nao acorda',
];

const ATENCAO = [
  'febre alta', 'dor muito forte', 'dor insuportavel', 'piorou muito',
  'nao para de vomitar', 'nao consigo levantar', 'urgente', 'emergencia',
  'to passando mal', 'estou passando mal', 'passando muito mal',
];

function avaliar(texto) {
  const t = normalizar(texto);
  for (const termo of EMERGENCIA) {
    if (t.includes(termo)) return { nivel: 'emergencia', termo };
  }
  for (const termo of ATENCAO) {
    if (t.includes(termo)) return { nivel: 'atencao', termo };
  }
  return { nivel: 'nenhum', termo: null };
}

module.exports = { avaliar, EMERGENCIA, ATENCAO };
