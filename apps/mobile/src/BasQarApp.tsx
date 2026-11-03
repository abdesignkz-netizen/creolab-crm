import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as WebBrowser from 'expo-web-browser';
import { WebView } from 'react-native-webview';
import { appLink, expiredExportFolder, externalLink, fileLink, FileTransfer, oauthCallback, oauthRequest, pdfRequest, trustedUrl } from './policy';
import { bridgeScript } from './webBridge';

const origin = Constants.expoConfig?.extra?.appOrigin || 'https://bsqr.kz';
const pushKey = 'basqar.push.token';
const consentKey = 'basqar.push.enabled';
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldPlaySound: false,
  shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }) });

async function cleanCachedExports() {
  if (!FileSystem.cacheDirectory) return;
  try {
    const names = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
    for (const name of names) if (expiredExportFolder(name, Date.now())) {
      await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${name}`, { idempotent: true });
    }
  } catch { /* Cache may already have been purged by the OS. */ }
}

function Cabinet() {
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [uri, setUri] = useState(`${origin}/today`);
  const [back, setBack] = useState(false);
  const [pushConfigured, setPushConfigured] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const userId = useRef<string | null>(null);
  const transfer = useRef(new FileTransfer());
  const fileTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sharing = useRef(false);
  const oauth = useRef<{ provider: string; state: string } | null>(null);
  const notificationToOpen = useRef<string | null>(null);
  const pending = useRef(new Map<string, { resolve: (message: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const script = (source: string) => web.current?.injectJavaScript(`${source}; true;`);

  const checkServer = useCallback(async () => {
    setError(''); setLoading(true);
    // RN 0.81's AbortSignal polyfill has no static timeout().
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${origin}/api/v1/mobile/config`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data.protocolVersion !== 1) throw new Error('Сервер BasQar ещё не обновлён для этой версии приложения.');
      setPushConfigured(data.pushConfigured === true); setReady(true);
    } catch (err) { setError(err instanceof Error && /ещё не обновлён/.test(err.message) ? err.message : 'Не удалось подключиться к BasQar. Проверьте интернет и повторите.'); }
    finally { clearTimeout(timer); setLoading(false); }
  }, []);

  function request(path: string, method: string, body: object): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.current.delete(id); reject(new Error('Не удалось получить подтверждение. Проверьте соединение и повторите.')); }, 20000);
      pending.current.set(id, { resolve, reject, timer });
      script(`window.BasQarNative?.request(${JSON.stringify(id)},${JSON.stringify(path)},${JSON.stringify(method)},${JSON.stringify(body)})`);
    });
  }

  async function syncPush(prompt: boolean) {
    if (!userId.current) { if (prompt) Alert.alert('Уведомления', 'Сначала войдите в аккаунт BasQar.'); return; }
    if (!pushConfigured || !Constants.expoConfig?.extra?.eas?.projectId) {
      if (prompt) Alert.alert('Уведомления', 'Push-уведомления ещё не настроены для этой сборки. Уведомления внутри BasQar доступны.');
      return;
    }
    const startingUser = userId.current;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('basqar', { name: 'BasQar', importance: Notifications.AndroidImportance.DEFAULT });
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && prompt && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      if (prompt) Alert.alert('Уведомления выключены', 'Разрешите уведомления в настройках телефона.', [
        { text: 'Закрыть' }, { text: 'Настройки', onPress: () => { void Linking.openSettings(); } }]);
      return;
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig.extra.eas.projectId })).data;
    if (startingUser !== userId.current) return;
    await request('/api/v1/me/mobile-devices', 'POST', { token, platform: Platform.OS });
    await SecureStore.setItemAsync(pushKey, token);
    await SecureStore.setItemAsync(consentKey, '1');
    script(`window.BasQarNative?.setDeviceToken(${JSON.stringify(token)})`);
    if (prompt) Alert.alert('Готово', 'Уведомления BasQar включены на этом устройстве.');
  }

  async function disablePush() {
    const token = await SecureStore.getItemAsync(pushKey);
    if (token) await request('/api/v1/me/mobile-devices', 'DELETE', { token });
    await SecureStore.setItemAsync(consentKey, '0');
    await SecureStore.deleteItemAsync(pushKey);
    script('window.BasQarNative?.setDeviceToken("")');
    Alert.alert('Готово', 'Push-уведомления на этом устройстве выключены.');
  }

  function acceptLink(value: string) {
    const callback = oauthCallback(value, origin, oauth.current);
    if (callback) { oauth.current = null; script(`location.assign(${JSON.stringify(callback)})`); return; }
    const target = appLink(value, origin);
    if (target) {
      if (web.current) script(`location.assign(${JSON.stringify(target)})`);
      else setUri(target);
    }
  }

  async function openExternal(url: string) {
    if (!externalLink(url)) return;
    const flow = oauthRequest(url, origin);
    if (flow) {
      if (oauth.current) return;
      oauth.current = flow;
      try {
        const result = await WebBrowser.openAuthSessionAsync(url, 'basqar://oauth');
        if (result.type === 'success') acceptLink(result.url);
      } finally { oauth.current = null; setLoading(false); }
    } else if (url.startsWith('https:')) {
      await WebBrowser.openBrowserAsync(url);
    } else { await Linking.openURL(url); }
  }

  useEffect(() => {
    void checkServer();
    void cleanCachedExports();
    void Linking.getInitialURL().then(value => { if (value) acceptLink(value); });
    const links = Linking.addEventListener('url', ({ url }) => acceptLink(url));
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') { script('window.BasQarNative?.session()'); void cleanCachedExports(); }
    });
    const notice = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data;
      // Resolve the destination and company server-side for the authenticated user.
      if (typeof data.notificationId === 'string' && data.notificationId.length <= 100) {
        notificationToOpen.current = data.notificationId;
        if (userId.current) { script(`window.BasQarNative?.openNotification(${JSON.stringify(data.notificationId)})`); notificationToOpen.current = null; }
      }
      void Notifications.clearLastNotificationResponseAsync();
    };
    const push = Notifications.addNotificationResponseReceivedListener(notice);
    void Notifications.getLastNotificationResponseAsync().then(value => { if (value) notice(value); });
    return () => { links.remove(); foreground.remove(); push.remove(); clearTimeout(fileTimer.current);
      for (const item of pending.current.values()) { clearTimeout(item.timer); item.reject(new Error('Приложение закрыто.')); } pending.current.clear(); };
  }, [checkServer]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { if (back) { web.current?.goBack(); return true; } return false; });
    return () => subscription.remove();
  }, [back]);

  async function message(raw: string, url: string) {
    if (!trustedUrl(url, origin) || raw.length > 4 * 1024 * 1024) return;
    let data: Record<string, any>;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || data.protocol !== 1) return;
    if (data.type !== 'print:pdf' && raw.length > 80000) return;
    if (data.type === 'result') {
      const item = pending.current.get(data.id); if (!item) return;
      clearTimeout(item.timer); pending.current.delete(data.id);
      if (data.ok) item.resolve(String(data.message || 'Готово')); else item.reject(new Error(String(data.message || 'Не удалось выполнить действие.')));
    } else if (data.type === 'session') {
      const next = typeof data.userId === 'string' ? data.userId : null;
      const changed = next !== userId.current;
      userId.current = next; setSignedIn(Boolean(next));
      if (next && notificationToOpen.current) {
        script(`window.BasQarNative?.openNotification(${JSON.stringify(notificationToOpen.current)})`);
        notificationToOpen.current = null;
      }
      const token = await SecureStore.getItemAsync(pushKey);
      if (token && next) script(`window.BasQarNative?.setDeviceToken(${JSON.stringify(token)})`);
      if (next && changed && await SecureStore.getItemAsync(consentKey) === '1') await syncPush(false);
    } else if (data.type === 'print:pdf') {
      if (sharing.current || transfer.current.active) throw new Error('Дождитесь сохранения предыдущего файла.');
      const document = pdfRequest(data);
      sharing.current = true;
      const directory = `${FileSystem.cacheDirectory}basqar-pdf-${Date.now()}/`;
      let generated: string | undefined;
      try {
        if (!await Sharing.isAvailableAsync()) throw new Error('Сохранение файлов недоступно на этом устройстве.');
        generated = (await Print.printToFileAsync({ html: document.html })).uri;
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
        const path = `${directory}${document.name}`;
        await FileSystem.moveAsync({ from: generated, to: path });
        generated = undefined;
        await Sharing.shareAsync(path, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Сохранить PDF' });
      } finally {
        sharing.current = false;
        if (generated) await FileSystem.deleteAsync(generated, { idempotent: true });
        if (Platform.OS !== 'android') await FileSystem.deleteAsync(directory, { idempotent: true });
      }
    } else if (typeof data.type === 'string' && data.type.startsWith('file:')) {
      if (sharing.current) {
        if (data.type === 'file:start') throw new Error('Дождитесь сохранения предыдущего файла.');
        return;
      }
      clearTimeout(fileTimer.current);
      fileTimer.current = setTimeout(() => transfer.current.reset(), 30000);
      const file = transfer.current.accept(data);
      if (!file) return;
      clearTimeout(fileTimer.current); sharing.current = true;
      const directory = `${FileSystem.cacheDirectory}basqar-${Date.now()}/`;
      try {
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
        const path = `${directory}${file.name}`;
        await FileSystem.writeAsStringAsync(path, file.base64, { encoding: FileSystem.EncodingType.Base64 });
        if (!await Sharing.isAvailableAsync()) throw new Error('Сохранение файлов недоступно на этом устройстве.');
        await Sharing.shareAsync(path, { dialogTitle: 'Сохранить или отправить документ' });
      } finally {
        sharing.current = false;
        if (Platform.OS !== 'android') await FileSystem.deleteAsync(directory, { idempotent: true });
      }
    } else if (data.type === 'error') { transfer.current.reset(); Alert.alert('BasQar', String(data.message || 'Не удалось выполнить действие.').slice(0, 300)); }
  }

  const report = (err: unknown) => { transfer.current.reset(); Alert.alert('BasQar', err instanceof Error ? err.message : 'Не удалось выполнить действие.'); };
  function menu() { setMenuOpen(true); }
  const menuItems = [
      { text: 'Обновить страницу', onPress: () => web.current?.reload() },
      ...(signedIn ? [{ text: 'Уведомления', onPress: () => Alert.alert('Уведомления', 'На этом устройстве', [
        { text: 'Включить', onPress: () => { void syncPush(true).catch(report); } },
        { text: 'Выключить', onPress: () => { void disablePush().catch(report); } }, { text: 'Отмена', style: 'cancel' as const }]) },
      { text: 'Удаление аккаунта', onPress: () => Alert.alert('Запросить удаление аккаунта?',
        'Запрос будет передан администратору сервиса. Документы компании, которые требуется хранить по закону, могут быть сохранены. До завершения проверки аккаунт продолжит работать. Статус запроса будет доступен в поддержке BasQar.', [
          { text: 'Отмена', style: 'cancel' as const }, { text: 'Отправить запрос', style: 'destructive' as const,
            onPress: () => { void request('/api/v1/me/account-deletion-request', 'POST', { confirm: true }).then(text => Alert.alert('Запрос принят', text)).catch(report); } },
        ]) }] : []),
      { text: 'Конфиденциальность', onPress: () => { void openExternal(`${origin}/legal/privacy`).catch(report); } },
    ];

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
    <StatusBar style="dark" />
    <Modal visible={menuOpen} transparent animationType="slide" onRequestClose={() => setMenuOpen(false)}>
      <View style={styles.modal}>
        <Pressable style={StyleSheet.absoluteFillObject} accessibilityLabel="Закрыть меню" onPress={() => setMenuOpen(false)} />
        <SafeAreaView style={styles.sheet} edges={['bottom']}>
          <Text style={styles.title}>Настройки приложения</Text>
          <ScrollView>{menuItems.map(item => <Pressable key={item.text} style={styles.menuItem} onPress={() => { setMenuOpen(false); item.onPress(); }}><Text style={styles.menuText}>{item.text}</Text></Pressable>)}</ScrollView>
          <Pressable style={styles.menuItem} onPress={() => setMenuOpen(false)}><Text style={styles.menuText}>Закрыть</Text></Pressable>
        </SafeAreaView>
      </View>
    </Modal>
    <View style={styles.bar}>
      <Pressable onPress={() => web.current?.goBack()} disabled={!back} accessibilityLabel="Назад" hitSlop={8} style={styles.nav}>
        <Text style={[styles.link, !back && { opacity: 0 }]}>{'‹'}</Text>
      </Pressable>
      <Text style={styles.brand}>BasQar</Text>
      <Pressable onPress={menu} accessibilityLabel="Настройки приложения" style={styles.nav}><Text style={styles.link}>•••</Text></Pressable>
    </View>
    {ready ? <WebView ref={web} source={{ uri }} style={{ flex: 1 }}
      applicationNameForUserAgent="BasQarNative/1"
      injectedJavaScriptBeforeContentLoaded={bridgeScript(origin)} injectedJavaScript={bridgeScript(origin)}
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly injectedJavaScriptForMainFrameOnly
      sharedCookiesEnabled thirdPartyCookiesEnabled={false} domStorageEnabled
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never" javaScriptCanOpenWindowsAutomatically={false}
      allowsBackForwardNavigationGestures allowsInlineMediaPlayback mediaCapturePermissionGrantType="prompt"
      setSupportMultipleWindows originWhitelist={['*']} textZoom={100} webviewDebuggingEnabled={__DEV__}
      onShouldStartLoadWithRequest={event => {
        if (event.isTopFrame !== false && fileLink(event.url, origin)) { script(`window.BasQarNative?.downloadUrl(${JSON.stringify(event.url)})`); return false; }
        if (trustedUrl(event.url, origin) || (event.isTopFrame === false && (event.url === 'about:blank' || event.url.startsWith(`blob:${origin}/`)))) return true;
        if (event.isTopFrame !== false) void openExternal(event.url).catch(report);
        return false;
      }}
      onOpenWindow={event => {
        const url = event.nativeEvent.targetUrl;
        if (fileLink(url, origin)) script(`window.BasQarNative?.downloadUrl(${JSON.stringify(url)})`);
        else if (trustedUrl(url, origin)) { script(`location.assign(${JSON.stringify(url)})`); }
        else void openExternal(url).catch(report);
      }}
      onFileDownload={event => { script(`window.BasQarNative?.downloadUrl(${JSON.stringify(event.nativeEvent.downloadUrl)})`); }}
      onMessage={event => { void message(event.nativeEvent.data, event.nativeEvent.url).catch(report); }}
      onNavigationStateChange={state => setBack(state.canGoBack)}
      onLoadStart={() => { setLoading(true); transfer.current.reset(); }} onLoadEnd={() => setLoading(false)}
      onError={() => { setError('Не удалось загрузить страницу. Проверьте интернет и повторите.'); setLoading(false); }}
      onHttpError={event => { if (event.nativeEvent.statusCode >= 500) setError('BasQar временно недоступен. Повторите немного позже.'); }}
      onContentProcessDidTerminate={() => setError('Просмотр был остановлен системой. Откройте страницу снова.')}
      onRenderProcessGone={() => setError('Просмотр был остановлен системой. Откройте страницу снова.')}
    /> : null}
    {loading && !error ? <View style={styles.loading} pointerEvents="none"><ActivityIndicator color="#0069CF" /></View> : null}
    {error ? <View style={styles.failure}><Text style={styles.title}>Не удалось открыть BasQar</Text><Text style={styles.message}>{error}</Text>
      <Pressable style={styles.button} onPress={() => { setError(''); if (ready) web.current?.reload(); else void checkServer(); }}><Text style={styles.buttonText}>Повторить</Text></Pressable></View> : null}
  </SafeAreaView>;
}

export default function BasQarApp() { return <SafeAreaProvider><Cabinet /></SafeAreaProvider>; }
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F7FB' }, bar: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF' },
  brand: { color: '#17243C', fontSize: 17, fontWeight: '700' }, nav: { minWidth: 48, minHeight: 44, justifyContent: 'center', alignItems: 'center' }, link: { color: '#0069CF', fontSize: 23 },
  loading: { position: 'absolute', top: '45%', alignSelf: 'center', backgroundColor: '#FFF', borderRadius: 12, padding: 16 },
  failure: { ...StyleSheet.absoluteFillObject, top: 50, padding: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5F7FB', gap: 18 },
  title: { fontSize: 22, fontWeight: '700', color: '#17243C', textAlign: 'center' }, message: { fontSize: 16, color: '#53627A', textAlign: 'center' },
  button: { backgroundColor: '#0069CF', borderRadius: 12, paddingHorizontal: 28, paddingVertical: 14 }, buttonText: { color: '#FFF', fontWeight: '600', fontSize: 16 },
  modal: { flex: 1, backgroundColor: '#0006', justifyContent: 'flex-end' }, sheet: { backgroundColor: '#FFF', padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' },
  menuItem: { paddingVertical: 16, minHeight: 48 }, menuText: { fontSize: 17, color: '#0069CF' },
});
