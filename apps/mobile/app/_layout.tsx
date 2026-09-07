import { Tabs } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { restoreSession, useSession } from "../src/lib/api";

const tabs = [
  { name: "today", title: "Ситуация", icon: "⌂" },
  { name: "inbox", title: "Заявки", icon: "≡" },
  { name: "deals", title: "Сделки", icon: "◇" },
  { name: "tasks", title: "Задачи", icon: "✓" },
  { name: "more", title: "Ещё", icon: "•••" },
];

export default function Layout() {
  return <SafeAreaProvider><MobileLayout /></SafeAreaProvider>;
}

function MobileLayout() {
  const insets = useSafeAreaInsets();
  const signedIn = useSession();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  async function restore() {
    setError("");
    try { await restoreSession(); setReady(true); }
    catch { setError("Не удалось восстановить вход."); }
  }
  useEffect(() => { void restore(); }, []);
  if (!ready) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 16 }}>
    {error ? <><Text>{error}</Text><Pressable onPress={restore} style={{ padding: 16 }}><Text>Повторить</Text></Pressable></> : <ActivityIndicator />}
  </View>;
  return <Tabs screenOptions={{
    headerStyle: { backgroundColor: "#F4F1EA" }, headerShadowVisible: false,
    tabBarActiveTintColor: "#0F6E6A", tabBarInactiveTintColor: "#6E6E78",
    tabBarHideOnKeyboard: true,
    tabBarStyle: { height: 60 + insets.bottom, paddingTop: 6, paddingBottom: Math.max(6, insets.bottom), backgroundColor: "#FFFCF7" },
    tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
  }}>
    <Tabs.Protected guard={!signedIn}>
      <Tabs.Screen name="index" options={{ href: null, headerShown: false, tabBarStyle: { display: "none" } }} />
    </Tabs.Protected>
    <Tabs.Protected guard={signedIn}>
      {tabs.map(tab => <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.title, tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 24 }} accessibilityElementsHidden>{tab.icon}</Text> }} />)}
    </Tabs.Protected>
  </Tabs>;
}
