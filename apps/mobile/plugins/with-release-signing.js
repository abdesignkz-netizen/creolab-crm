const { withAppBuildGradle } = require('expo/config-plugins');

// Prebuild must never silently sign a release with Android's public debug key.
module.exports = config => withAppBuildGradle(config, config => {
  let value = config.modResults.contents;
  if (!value.includes('basqarRelease')) {
    value = value.replace('signingConfigs {', `signingConfigs {
        basqarRelease {
            if (System.getenv("BASQAR_ANDROID_KEYSTORE")) {
                storeFile file(System.getenv("BASQAR_ANDROID_KEYSTORE"))
                storePassword System.getenv("BASQAR_ANDROID_STORE_PASSWORD")
                keyAlias System.getenv("BASQAR_ANDROID_KEY_ALIAS")
                keyPassword System.getenv("BASQAR_ANDROID_KEY_PASSWORD")
            }
        }`);
    const marker = 'release {';
    const start = value.indexOf(marker, value.indexOf('buildTypes {'));
    if (start < 0) throw new Error('Android release block missing: review the signing plugin.');
    value = value.slice(0, start) + value.slice(start).replace('signingConfig signingConfigs.debug',
      'signingConfig System.getenv("BASQAR_ANDROID_KEYSTORE") ? signingConfigs.basqarRelease : null');
    if (value.slice(start).includes('signingConfig signingConfigs.debug')) throw new Error('Unsafe release signing');
  }
  config.modResults.contents = value;
  return config;
});
