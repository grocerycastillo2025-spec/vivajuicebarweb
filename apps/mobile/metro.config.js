// Metro en monorepo: hay que vigilar la raiz del workspace y buscar
// dependencias tanto en apps/mobile/node_modules como en la raiz.
//
// NO se toca `disableHierarchicalLookup`. La recomendacion de ponerlo en
// `true` es para pnpm con node_modules aislado, donde el ascenso por el
// arbol encuentra enlaces equivocados. Aqui el `.npmrc` fija
// `node-linker=hoisted`, asi que el arbol es plano y el ascenso normal de
// Metro resuelve bien: desactivarlo solo servia para que `expo-doctor`
// marcase el check en rojo.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
