import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../src/lib/api";

export default function DealsScreen() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    api.deals().then((data: any) => setItems(data.items));
  }, []);
  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: "#F4F1EA" }}>
      <Text style={{ fontSize: 24 }}>Сделки</Text>
      {items.map((item) => (
        <Text key={item.id}>{item.title} · {item.outcome}</Text>
      ))}
    </View>
  );
}
