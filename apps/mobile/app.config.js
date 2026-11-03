const path = require('node:path');
const linkPaths = require('./link-paths.json');

// Only public configuration belongs here. Signing keys stay in EAS/CI secrets.
module.exports = () => {
  const profile = process.env.EAS_BUILD_PROFILE || 'production';
  const development = profile === 'development';
  const origin = new URL(process.env.BASQAR_APP_URL || 'https://bsqr.kz');
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      (!development && origin.href !== 'https://bsqr.kz/')) {
    throw new Error('Release builds must use https://bsqr.kz without a path, credentials or query.');
  }
  if (origin.protocol !== 'https:' && !(development && origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(origin.hostname))) {
    throw new Error('Only HTTPS is permitted outside a local development build.');
  }
  const projectId = process.env.BASQAR_EAS_PROJECT_ID;
  if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('BASQAR_EAS_PROJECT_ID must be the real EAS project UUID.');
  }
  const appleTeamId = process.env.BASQAR_APPLE_TEAM_ID;
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) throw new Error('Invalid Apple Team ID');
  const verifiedLinks = process.env.BASQAR_VERIFIED_LINKS === '1';
  return {
    name: 'BasQar', slug: 'basqar', version: '1.0.0', scheme: 'basqar', platforms: ['ios', 'android'],
    ...(process.env.BASQAR_EXPO_OWNER ? { owner: process.env.BASQAR_EXPO_OWNER } : {}),
    orientation: 'default', userInterfaceStyle: 'light', newArchEnabled: true,
    icon: './assets/icon.png',
    ios: {
      bundleIdentifier: 'kz.bsqr.app', buildNumber: '1', supportsTablet: true,
      ...(appleTeamId ? { appleTeamId } : {}),
      ...(verifiedLinks ? { associatedDomains: ['applinks:bsqr.kz'] } : {}),
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSCameraUsageDescription: 'Снять фото или документ и прикрепить его в BasQar.',
        NSMicrophoneUsageDescription: 'Записать голосовое сообщение в диалоге BasQar.',
        NSPhotoLibraryUsageDescription: 'Выбрать фото или документ для отправки в BasQar.',
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
      },
    },
    android: {
      package: 'kz.bsqr.app', versionCode: 1, allowBackup: false,
      softwareKeyboardLayoutMode: 'resize',
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#FFFFFF' },
      permissions: ['CAMERA', 'RECORD_AUDIO', 'POST_NOTIFICATIONS'],
      blockedPermissions: ['READ_CONTACTS', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION',
        'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO',
        'READ_MEDIA_AUDIO', 'SYSTEM_ALERT_WINDOW'],
      ...(process.env.BASQAR_GOOGLE_SERVICES_FILE ? { googleServicesFile: path.resolve(process.env.BASQAR_GOOGLE_SERVICES_FILE) } : {}),
      ...(verifiedLinks ? { intentFilters: [{ action: 'VIEW', autoVerify: true,
        data: linkPaths.flatMap(route => [
          { scheme: 'https', host: 'bsqr.kz', path: `/${route}` },
          { scheme: 'https', host: 'bsqr.kz', pathPrefix: `/${route}/` },
        ]), category: ['BROWSABLE', 'DEFAULT'] }] } : {}),
    },
    plugins: [
      ['expo-secure-store', { faceIDPermission: false }],
      'expo-system-ui',
      'expo-web-browser',
      ['expo-splash-screen', { image: './assets/splash.png', imageWidth: 160, backgroundColor: '#F5F7FB' }],
      ['expo-notifications', { icon: './assets/notification-icon.png', color: '#0069CF', defaultChannel: 'basqar' }],
      ['expo-build-properties', { android: { compileSdkVersion: 36, targetSdkVersion: 36,
        minSdkVersion: 24, usesCleartextTraffic: development && origin.protocol === 'http:' } }],
      './plugins/with-release-signing.js',
    ],
    extra: { appOrigin: origin.origin, environment: development ? 'development' : 'production',
      ...(projectId ? { eas: { projectId } } : {}) },
  };
};
