import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { api } from "../src/lib/api";

export default function InboxScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState("Мобильный клиент");
  const [phone, setPhone] = useState("+77010000004");
  const [error, setError] = useState("");
  async function load() {
    const data = (await api.inquiries()) as { items: any[] };
    setItems(data.items);
  }
  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Входящие</Text>
      <TextInput value={name} onChangeText={setName} style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      <TextInput value={phone} onChangeText={setPhone} style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
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
          <Text>{item.phoneRaw}</Text>
          <Pressable onPress={() => api.acceptInquiry(item.id).then(load)}>
            <Text>Принять</Text>
          </Pressable>
          <Pressable onPress={() => api.convertInquiry(item.id).then(load)}>
            <Text>В сделку</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}
