import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { Link } from "expo-router";
import { api, clearSession } from "../src/lib/api";

export default function MoreScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .notifications()
      .then((data: any) => setItems(data.items || data))
      .catch(err => setError(err instanceof Error ? err.message : "Не удалось загрузить уведомления"));
  }, []);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      {error ? <Text>{error}</Text> : null}
      <Link href="/today">Ситуация</Link>
      {items.slice(0, 8).map((item) => (
        <Link key={item.id} href="/today">
          {item.title}
        </Link>
      ))}
      <Text>Уведомления о заявке и «нужен человек» открывают ситуацию, не отдельный inbox.</Text>
      <Pressable style={{ paddingVertical: 16 }} onPress={async () => {
        try { await api.request("/api/v1/auth/logout", { method: "POST", body: "{}" }); await clearSession(); }
        catch (err) { setError(err instanceof Error ? err.message : "Не удалось выйти"); }
      }}><Text>Выйти</Text></Pressable>
    </ScrollView>
  );
}
