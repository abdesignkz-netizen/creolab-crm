import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "../src/lib/api";

export default function DealsScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    try { const data: any = await api.deals({ view: "list" }); setItems(data.items || []); setError(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось загрузить сделки"); }
    finally { setLoading(false); }
  }
  useFocusEffect(useCallback(() => { void load(); }, []));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      {loading ? <Text>Загрузка…</Text> : null}
      {error ? <><Text>{error}</Text><Pressable onPress={load} style={{ padding: 12 }}><Text>Повторить</Text></Pressable></> : null}
      {!loading && !error && !items.length ? <Text>Сделок пока нет.</Text> : null}
      {items.map((item) => (
        <Text key={item.id}>{item.title} · {({ open: "В работе", won: "Продана", lost: "Потеряна", on_hold: "На паузе" } as Record<string, string>)[item.outcome] || item.outcome}</Text>
      ))}
    </ScrollView>
  );
}
