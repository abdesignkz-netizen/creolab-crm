import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { api } from "../src/lib/api";

function statusLine(item: { status?: string }) {
  return (
    ({ open: "К выполнению", in_progress: "В работе", waiting: "Жду", done: "Завершено", canceled: "Отменено" } as Record<
      string,
      string
    >)[String(item.status || "")] || item.status
  );
}

export default function TasksScreen() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const data = (await api.tasks()) as { items: any[] };
    setItems(data.items);
  }

  useFocusEffect(
    useCallback(() => {
      load().catch((err) => setError(err.message));
    }, []),
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Задачи</Text>
      {error ? <Text>{error}</Text> : null}
      {items.map((item) => (
        <View key={item.id} style={{ padding: 12, backgroundColor: "#FFFCF7", gap: 8 }}>
          <Text>
            {item.title} · {statusLine(item)}
          </Text>
          <Text style={{ color: "#6b7280" }}>
            {item.dueAt ? new Date(item.dueAt).toLocaleString("ru-RU") : "Без срока"}
          </Text>
          <Text style={{ color: "#6b7280" }}>
            Поставил: {item.createdByLabel || "—"} · Исполнитель: {item.assigneeLabel || item.assigneeName || "—"}
          </Text>
          {item.overdue ? <Text style={{ color: "#c45c26" }}>Просрочено</Text> : null}
          {item.status === "open" || item.status === "waiting" || item.status === "in_progress" ? (
            <Pressable
              onPress={() =>
                api
                  .completeTask(item.id)
                  .then(load)
                  .catch((err) => setError(err instanceof Error ? err.message : "Нельзя закрыть"))
              }
            >
              <Text>Завершить</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
