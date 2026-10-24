"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Wallet,
  Newspaper,
  Eye,
  Lightbulb,
  Plug,
} from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/holdings", label: "Holdings", icon: Wallet },
  { href: "/news", label: "News", icon: Newspaper },
  { href: "/watchlist", label: "Watchlist", icon: Eye },
  { href: "/theses", label: "Theses", icon: Lightbulb },
  { href: "/settings/connections", label: "Connections", icon: Plug },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 md:flex-col">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              active && "bg-muted font-medium text-foreground",
            )}
          >
            <Icon className="size-4" />
            <span className="hidden sm:inline">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
