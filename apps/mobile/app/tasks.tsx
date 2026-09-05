import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { api } from "../src/lib/api";

export default function TasksScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const data = (await api.tasks()) as { items: any[] };
    setItems(data.items);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Задачи</Text>
      {error ? <Text>{error}</Text> : null}
      {items.map((item) => (
        <View key={item.id} style={{ padding: 12, backgroundColor: "#FFFCF7", gap: 8 }}>
          <Text>
            {item.title} · {item.status}
          </Text>
          {item.status === "open" || item.status === "waiting" ? (
            <Pressable
              onPress={() =>
                api
                  .completeTask(item.id)
                  .then(load)
                  .catch((err) => setError(err instanceof Error ? err.message : "Нельзя закрыть"))
              }
            >
              <Text>Сделано</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
