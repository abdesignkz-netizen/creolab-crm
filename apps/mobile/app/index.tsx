import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { api, saveSession } from "../src/lib/api";

export default function LoginScreen() {
  const [email, setEmail] = useState("owner@creolab.example");
  const [password, setPassword] = useState("ChangeMeLocal1!");
  const [error, setError] = useState("");

  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: "#F4F1EA", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 28 }}>Вход</Text>
      <Text>Телефон не нужен. WhatsApp можно не подключать.</Text>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      <TextInput value={password} onChangeText={setPassword} secureTextEntry style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      {error ? <Text>{error}</Text> : null}
      <Pressable
        style={{ backgroundColor: "#0F6E6A", padding: 14, minHeight: 44 }}
        onPress={async () => {
          try {
            const result = (await api.login(email, password, "mobile")) as { accessToken?: string; refreshToken?: string };
            if (result.accessToken && result.refreshToken) {
              await saveSession(result.accessToken, result.refreshToken);
            }
            router.replace("/today");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Ошибка входа");
          }
        }}
      >
        <Text style={{ color: "#fff", textAlign: "center" }}>Войти</Text>
      </Pressable>
    </View>
  );
}
