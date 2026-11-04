// Подпись APK постоянным ключом (решение 0011): Android ставит новую версию поверх старой,
// только если обе подписаны одним ключом. Отладочный ключ у каждой машины CI свой — поэтому свой ключ.
//
// node android-signing.mjs <путь к gen/android> <путь к .jks>   (пароль — в ANDROID_KEYSTORE_PASSWORD)
// Пишет keystore.properties рядом с проектом и подключает подпись к сборке release в app/build.gradle.kts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = '// kayospace: подпись release';

const SIGNING = `    ${MARK}
    signingConfigs {
        create("release") {
            val props = Properties().apply {
                rootProject.file("keystore.properties").inputStream().use { load(it) }
            }
            keyAlias = props.getProperty("keyAlias")
            keyPassword = props.getProperty("password")
            storeFile = file(props.getProperty("storeFile"))
            storePassword = props.getProperty("password")
        }
    }
`;

/** Вставить подпись в build.gradle.kts; повторный вызов ничего не меняет. */
export function patchGradle(src) {
  if (src.includes(MARK)) return src;
  if (!src.includes('import java.util.Properties')) src = `import java.util.Properties\n${src}`;
  const android = src.indexOf('\nandroid {\n');
  if (android < 0) throw new Error('нет блока android { } в build.gradle.kts');
  const at = android + '\nandroid {\n'.length;
  src = src.slice(0, at) + SIGNING + src.slice(at);
  const release = /getByName\("release"\)\s*\{\n/.exec(src);
  if (!release) throw new Error('нет getByName("release") в build.gradle.kts');
  const pos = release.index + release[0].length;
  return (
    src.slice(0, pos) +
    '            signingConfig = signingConfigs.getByName("release")\n' +
    src.slice(pos)
  );
}

export function keystoreProperties(storeFile, password, alias = 'kayospace') {
  // В .properties обратная косая черта — спецсимвол; пароль и путь экранируем.
  const esc = (v) => v.replace(/\\/g, '\\\\').replace(/\n/g, '');
  return `storeFile=${esc(storeFile)}\npassword=${esc(password)}\nkeyAlias=${esc(alias)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [project, jks] = process.argv.slice(2);
  const password = process.env.ANDROID_KEYSTORE_PASSWORD;
  if (!project || !jks || !password) {
    console.error(
      'node android-signing.mjs <gen/android> <.jks>, пароль — в ANDROID_KEYSTORE_PASSWORD',
    );
    process.exit(2);
  }
  const gradle = join(project, 'app', 'build.gradle.kts');
  writeFileSync(gradle, patchGradle(readFileSync(gradle, 'utf8')));
  writeFileSync(join(project, 'keystore.properties'), keystoreProperties(jks, password));
  console.log('Подпись release подключена');
}
