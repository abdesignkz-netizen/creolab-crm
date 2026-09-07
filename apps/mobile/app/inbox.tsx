import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api } from "../src/lib/api";

export default function InboxScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState("Мобильный клиент");
  const [phone, setPhone] = useState("+77010000004");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState({ total: 0, offset: 0, limit: 50 });
  async function load(offset = page.offset) {
    const data = (await api.inquiries({ offset })) as { items: any[]; total: number; offset: number; limit: number };
    setItems(data.items);
    setPage({ total: data.total, offset: data.offset, limit: data.limit });
    setError("");
  }
  useFocusEffect(useCallback(() => {
    load(0).catch((err) => setError(err.message));
  }, []));
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try { await action(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось выполнить действие"); }
    finally { setBusy(false); }
  }
  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Входящие</Text>
      <TextInput value={name} onChangeText={setName} style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      {error ? <Text>{error}</Text> : null}
      <Pressable
        style={{ backgroundColor: "#0F6E6A", padding: 14 }}
        onPress={async () => {
          try {
            await api.createInquiry({ name, phone, subject: "Мобильная заявка" });
            await load();
          } catch (err: any) {
            setError(err.body?.field_errors?.phone || err.message);
          }
        }}
      >
        <Text style={{ color: "#fff" }}>Создать заявку</Text>
      </Pressable>
      {items.map((item) => (
        <View key={item.id} style={{ padding: 12, backgroundColor: "#FFFCF7" }}>
          <Text>{item.subject}</Text>
          <Text>{item.contactName} · {item.phone || "Нет телефона"}</Text>
          <Text>{item.statusLabel}</Text>
          <Pressable disabled={busy} onPress={() => run(() => api.acceptInquiry(item.id))} style={{ paddingVertical: 12 }}>
            <Text>Принять</Text>
          </Pressable>
          <Pressable disabled={busy || item.hasDeal} onPress={() => run(() => api.convertInquiry(item.id))} style={{ paddingVertical: 12 }}>
            <Text>В сделку</Text>
          </Pressable>
        </View>
      ))}
      <Text>{page.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} из ${page.total}` : "Заявок пока нет"}</Text>
      <View style={{ flexDirection: "row", gap: 16 }}>
        {page.offset > 0 ? <Pressable style={{ padding: 12 }} onPress={() => load(Math.max(0, page.offset - page.limit)).catch(err => setError(err.message))}><Text>Назад</Text></Pressable> : null}
        {page.offset + page.limit < page.total ? <Pressable style={{ padding: 12 }} onPress={() => load(page.offset + page.limit).catch(err => setError(err.message))}><Text>Далее</Text></Pressable> : null}
      </View>
    </ScrollView>
  );
}
