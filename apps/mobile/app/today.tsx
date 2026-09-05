import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Link, useFocusEffect } from "expo-router";
import { api } from "../src/lib/api";

const ACTION_LABEL: Record<string, string> = {
  complete_phone: "Дописать телефон",
  accept_inquiry: "Принять заявку",
  open_inquiry: "Открыть заявку",
  take_conversation: "Забрать себе",
  reply_human: "Ответить",
  return_to_ai: "Вернуть ИИ",
  resume_paused: "Снять паузу",
  complete_task: "Закрыть задачу",
  assign_owner: "Назначить себе",
  instruct_ai: "Поручить ИИ",
};

export default function TodayScreen() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [phone, setPhone] = useState("");

  async function load() {
    try {
      setData(await api.situation({ scope: "all" }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, []),
  );

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не выполнено");
    }
  }

  if (error && !data) {
    return (
      <View style={{ padding: 20 }}>
        <Text>{error}</Text>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={{ padding: 20 }}>
        <Text>Загрузка…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#F4F1EA" }} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Ситуация</Text>
      {data.freshness.warning ? <Text>{data.freshness.warning}</Text> : null}
      {error ? <Text>{error}</Text> : null}
      <Text>Сейчас: {data.metrics.now}</Text>
      <Text>Без телефона: {data.metrics.blocked}</Text>
      <Text>Нужен человек: {data.metrics.needsHuman}</Text>
      <Text>Просрочено: {data.metrics.overdue}</Text>
      {data.items.map((item: any) => (
        <View key={item.id} style={{ padding: 12, backgroundColor: "#FFFCF7", gap: 8 }}>
          <Text style={{ fontWeight: "600" }}>{item.title}</Text>
          <Text>{item.reason}</Text>
          {item.nextAction === "complete_phone" ? (
            <>
              <TextInput
                value={phone}
                onChangeText={setPhone}
                placeholder="+7..."
                style={{ borderWidth: 1, padding: 12, minHeight: 44 }}
              />
              <Pressable
                style={{ backgroundColor: "#0F6E6A", padding: 12 }}
                onPress={() => run(() => api.completeIntake(item.entityId, { phone }))}
              >
                <Text style={{ color: "#fff" }}>{ACTION_LABEL.complete_phone}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              style={{ backgroundColor: "#0F6E6A", padding: 12 }}
              onPress={() => {
                if (item.nextAction === "accept_inquiry") return run(() => api.acceptInquiry(item.entityId));
                if (item.nextAction === "take_conversation") return run(() => api.takeConversation(item.entityId));
                if (item.nextAction === "complete_task") return run(() => api.completeTask(item.entityId));
                if (item.nextAction === "assign_owner") return run(() => api.assignTask(item.entityId));
                if (item.nextAction === "resume_paused" || item.nextAction === "return_to_ai") {
                  return run(() => api.returnToAi(item.entityId));
                }
              }}
            >
              <Text style={{ color: "#fff" }}>{ACTION_LABEL[item.nextAction] || "Открыть"}</Text>
            </Pressable>
          )}
        </View>
      ))}
      <Link href="/inbox">Входящие</Link>
      <Link href="/deals">Сделки</Link>
      <Link href="/tasks">Задачи</Link>
      <Link href="/more">Ещё</Link>
    </ScrollView>
  );
}
