import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
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
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не выполнено");
    } finally { setBusy(false); }
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
      <Text style={{ fontSize: 24 }}>Главная</Text>
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
                value={phones[item.id] || ""}
                onChangeText={value => setPhones(previous => ({ ...previous, [item.id]: value }))}
                keyboardType="phone-pad"
                placeholder="+7..."
                style={{ borderWidth: 1, padding: 12, minHeight: 44 }}
              />
              <Pressable
                style={{ backgroundColor: "#0F6E6A", padding: 12 }}
                disabled={busy}
                onPress={() => run(() => api.completeIntake(item.entityId, { phone: phones[item.id] || "" }))}
              >
                <Text style={{ color: "#fff" }}>{ACTION_LABEL.complete_phone}</Text>
              </Pressable>
            </>
          ) : ["accept_inquiry", "take_conversation", "complete_task", "assign_owner", "resume_paused", "return_to_ai", "open_inquiry"].includes(item.nextAction) ? (
            <Pressable
              style={{ backgroundColor: "#0F6E6A", padding: 12 }}
              disabled={busy}
              onPress={() => {
                if (item.nextAction === "open_inquiry") { router.push("/inbox"); return; }
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
          ) : <Text style={{ color: "#6E6E78" }}>Продолжите это действие в веб-версии CRM.</Text>}
        </View>
      ))}
    </ScrollView>
  );
}
