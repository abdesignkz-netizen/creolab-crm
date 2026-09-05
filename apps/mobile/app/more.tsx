import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Link } from "expo-router";
import { api } from "../src/lib/api";

export default function MoreScreen() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    api
      .notifications()
      .then((data: any) => setItems(data.items || data))
      .catch(() => setItems([]));
  }, []);
  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: "#F4F1EA", gap: 12 }}>
      <Text style={{ fontSize: 24 }}>Ещё</Text>
      <Link href="/today">Ситуация</Link>
      {items.slice(0, 8).map((item) => (
        <Link key={item.id} href="/today">
          {item.title}
        </Link>
      ))}
      <Text>Уведомления о заявке и «нужен человек» открывают ситуацию, не отдельный inbox.</Text>
    </View>
  );
}
