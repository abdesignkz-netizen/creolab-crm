import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { api, saveSession } from "../src/lib/api";

export default function LoginScreen() {
  const [email, setEmail] = useState("owner@creolab.example");
  const [password, setPassword] = useState("ChangeMeLocal1!");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: "#F4F1EA", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 28 }}>Вход</Text>
      <Text>Телефон не нужен. WhatsApp можно не подключать.</Text>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      <TextInput value={password} onChangeText={setPassword} secureTextEntry style={{ borderWidth: 1, padding: 12, minHeight: 44 }} />
      {error ? <Text>{error}</Text> : null}
      <Pressable
        disabled={busy}
        style={{ backgroundColor: "#0F6E6A", padding: 14, minHeight: 44 }}
        onPress={async () => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const result = (await api.login(email, password, "mobile")) as { accessToken?: string; refreshToken?: string };
            if (!result.accessToken || !result.refreshToken) throw new Error("Не удалось создать сессию");
            await saveSession(result.accessToken, result.refreshToken);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Ошибка входа");
          } finally { setBusy(false); }
        }}
      >
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Вход…" : "Войти"}</Text>
      </Pressable>
    </View>
  );
}
