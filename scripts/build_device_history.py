"""
Preprocesses Historial_Players_Tableau.csv.gz into two compact JSON files used
by the HubSpot enrichment review app:

- device_history_by_client.json: per end-client (Cliente) aggregate — active
  devices, country, which partner/reseller group serves them.
- device_history_by_partner.json: per partner/reseller group aggregate — total
  active devices they manage across all their end clients, and the list of
  clients. Used to propose company_score (screen-based tiers) for Partner
  companies.

Run once (re-run when the export is refreshed) -- output is committed into
the app's data/ folder.
"""
import csv
import gzip
import json
from collections import defaultdict, Counter

SRC = "/Users/leandrobraier/Desktop/manelmasia/Projectes/nsign/Projectes/Dashboard-Players-HistoricDevices/Historial_Players_Tableau.csv.gz"
OUT_DIR = "/Users/leandrobraier/Desktop/manelmasia/Projectes/nsign/Projectes/Neteja-CRM-HubSpot/hubspot-enrichment-review/data"

NETIPBOX_MARKERS = ("NETIPBOX",)


def is_direct_channel(partner_group: str) -> bool:
    return any(marker in (partner_group or "").upper() for marker in NETIPBOX_MARKERS)


def main():
    clients = defaultdict(lambda: {
        "active_devices": 0,
        "total_devices_ever": 0,
        "countries": Counter(),
        "partner_groups": Counter(),
        "last_movement": "",
    })
    partners = defaultdict(lambda: {"active_devices": 0, "clients": set()})

    with gzip.open(SRC, "rt", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cliente = (row.get("Cliente") or "").strip()
            if not cliente:
                continue
            c = clients[cliente]
            c["total_devices_ever"] += 1
            active = row.get("Player Activo Actualmente") == "True"
            fecha = row.get("Fecha Movimiento") or ""
            if fecha > c["last_movement"]:
                c["last_movement"] = fecha
            if not active:
                continue
            c["active_devices"] += 1
            pais = (row.get("Pais") or "").strip()
            if pais:
                c["countries"][pais] += 1
            pg = (row.get("Partner (Group)") or "").strip()
            if pg:
                c["partner_groups"][pg] += 1
                if not is_direct_channel(pg):
                    partners[pg]["active_devices"] += 1
                    partners[pg]["clients"].add(cliente)

    clients_out = {}
    for cliente, c in clients.items():
        if c["active_devices"] == 0:
            continue
        top_partner = c["partner_groups"].most_common(1)
        top_country = c["countries"].most_common(1)
        clients_out[cliente] = {
            "active_devices": c["active_devices"],
            "total_devices_ever": c["total_devices_ever"],
            "country": top_country[0][0] if top_country else None,
            "partner_group": top_partner[0][0] if top_partner else None,
            "is_direct_channel": is_direct_channel(top_partner[0][0]) if top_partner else None,
            "last_movement": c["last_movement"],
        }

    partners_out = {
        name: {
            "active_devices": p["active_devices"],
            "managed_clients": sorted(p["clients"]),
            "managed_client_count": len(p["clients"]),
        }
        for name, p in partners.items()
    }

    with open(f"{OUT_DIR}/device_history_by_client.json", "w", encoding="utf-8") as f:
        json.dump(clients_out, f, ensure_ascii=False, indent=1, sort_keys=True)
    with open(f"{OUT_DIR}/device_history_by_partner.json", "w", encoding="utf-8") as f:
        json.dump(partners_out, f, ensure_ascii=False, indent=1, sort_keys=True)

    print(f"Wrote {len(clients_out)} end-clients and {len(partners_out)} partner groups")


if __name__ == "__main__":
    main()
