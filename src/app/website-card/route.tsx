import { ImageResponse } from "next/og";
import { publicWebsiteBrand } from "@/platform/website/site";

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    <div style={{
      width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "#182326", color: "#f5f6f2", fontSize: 88, fontWeight: 700, letterSpacing: 7, padding: "90px"
    }}>
      {publicWebsiteBrand}
      <div style={{ display: "flex", position: "relative", width: 420, height: 450, background: "#fff4ef", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 65, left: 42, width: 336, height: 420, borderRadius: "170px 170px 0 0", background: "#9f3f1b" }} />
        <div style={{ position: "absolute", top: 127, left: 87, width: 246, height: 360, borderRadius: "125px 125px 0 0", background: "#eef3ef" }} />
        <div style={{ position: "absolute", top: 190, left: 132, width: 156, height: 300, borderRadius: "80px 80px 0 0", background: "#0b6b5f" }} />
      </div>
    </div>,
    { width: 1200, height: 630 }
  );
}
