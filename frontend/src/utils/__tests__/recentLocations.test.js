import { pushRecentLocation, recentFromTrips } from "../recentLocations";

describe("recentLocations", () => {
  test("keeps newest first and removes duplicates", () => {
    let list = [];
    list = pushRecentLocation(list, { name: "A", lat: 24.7, lng: 46.6 });
    list = pushRecentLocation(list, { name: "B", lat: 24.8, lng: 46.7 });
    list = pushRecentLocation(list, { name: "A again", lat: 24.7, lng: 46.6 });
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("A again");
    expect(list[1].name).toBe("B");
  });

  test("limits to five entries", () => {
    let list = [];
    for (let i = 0; i < 8; i += 1) {
      list = pushRecentLocation(list, { name: `P${i}`, lat: 24 + i * 0.01, lng: 46 });
    }
    expect(list).toHaveLength(5);
    expect(list[0].name).toBe("P7");
  });

  test("seeds from trip history", () => {
    const recent = recentFromTrips([
      {
        originName: "العليا",
        destName: "المطار",
        startLat: 24.71,
        startLng: 46.67,
        endLat: 24.95,
        endLng: 46.7,
      },
    ]);
    expect(recent.length).toBe(2);
    expect(recent[0].name).toBe("المطار");
  });
});
