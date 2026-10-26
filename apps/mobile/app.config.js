/**
 * Configuracion dinamica, encima de app.json.
 *
 * Existe por una sola razon: `google-services.json`, el archivo que
 * Android necesita para recibir notificaciones. No esta versionado, y ahi
 * esta el detalle que costo un build:
 *
 *   EAS SOLO SUBE AL BUILDER LO QUE ESTA EN GIT.
 *
 * Escribirlo en el runner de Actions no sirve de nada: el archivo existe
 * mientras se resuelve la configuracion, se declara en
 * `android.googleServicesFile`, y despues NO viaja. En la maquina de EAS
 * la ruta apunta a un archivo que no esta y el build muere.
 *
 * La via que si funciona es una variable de entorno de EAS de tipo
 * `file`: EAS escribe el archivo en el builder y deja en la variable su
 * RUTA absoluta. Por eso aqui se busca primero la ruta que venga por
 * entorno y solo despues un archivo local, que es el caso del que
 * desarrolla en su maquina.
 *
 * Y en los dos casos se comprueba que el archivo EXISTE antes de
 * declararlo. Declarar una ruta que no esta es exactamente lo que hizo
 * fallar el build; sin el archivo la app compila igual y lo unico que no
 * hace es registrarse para notificaciones, cosa que la pantalla de perfil
 * ya explica.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Nombre de la variable de entorno de tipo `file` en EAS. */
const ENV_VAR = 'GOOGLE_SERVICES_JSON';
const FILE_NAME = 'google-services.json';

function findGoogleServices() {
  const fromEas = process.env[ENV_VAR];

  if (fromEas !== undefined && fromEas.trim() !== '') {
    if (fs.existsSync(fromEas)) return { file: fromEas, source: `variable ${ENV_VAR} de EAS` };
    // Pasa si alguien crea la variable como texto en vez de como
    // archivo: llega el contenido del JSON donde se esperaba una ruta.
    console.warn(
      `[app.config] ${ENV_VAR} no apunta a un archivo existente. ` +
        'En EAS tiene que ser una variable de tipo "file", no de tipo texto.',
    );
  }

  const local = path.join(__dirname, FILE_NAME);
  if (fs.existsSync(local)) return { file: `./${FILE_NAME}`, source: 'archivo local' };

  return null;
}

/**
 * Ruta base de la app web. Vacia con dominio propio; "/<repo>" cuando se
 * sirve desde GitHub Pages. La pone el workflow `deploy-web.yml`.
 */
function withWebBaseUrl(config) {
  const baseUrl = (process.env.EXPO_WEB_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrl === '') return config;
  return { ...config, experiments: { ...config.experiments, baseUrl } };
}

module.exports = ({ config: rawConfig }) => {
  const config = withWebBaseUrl(rawConfig);
  const found = findGoogleServices();

  if (found === null) {
    // Aviso, no error: en local es lo normal, y en un build significa
    // que ese APK no tendra push, no que haya que abortar.
    console.warn(
      `[app.config] Sin ${FILE_NAME}: esta build no podra recibir notificaciones push.`,
    );
    return config;
  }

  console.log(`[app.config] ${FILE_NAME} tomado de: ${found.source}`);
  return {
    ...config,
    android: { ...config.android, googleServicesFile: found.file },
  };
};
