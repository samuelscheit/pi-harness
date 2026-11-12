import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { cn } from "./lib";
import { ContextView } from "./usage/context";
import { DriversView } from "./usage/drivers";
import { FilterBar, useFilterSearch } from "./usage/filters";
import { OverviewView } from "./usage/overview";
import { SessionDetailView, SessionsView } from "./usage/sessions";
import { SubagentsView } from "./usage/subagents";
import { VersionsView } from "./usage/versions";
import { WasteView } from "./usage/waste";

const SECTIONS = [
	{ to: "/", label: "Overview", title: "Usage", end: true, description: "What drove spend in the selected range, ranked by dollars." },
	{ to: "/drivers", label: "Cost drivers", description: "Spend split by what caused it: prompt content, tool, model, project, source, context size or day." },
	{ to: "/context", label: "Context & tools", description: "What tool results cost while they stay in context, which were never used again, and how large prompts get." },
	{ to: "/sessions", label: "Sessions", description: "Sessions and subagents, ranked by what they cost." },
	{ to: "/waste", label: "Waste", description: "Cache rebuilds, pauses that let the cache expire, and compactions that would have paid off." },
	{ to: "/subagents", label: "Subagents", description: "Starting a new subagent against resuming an idle earlier one." },
	{ to: "/versions", label: "Harness versions", description: "Each prompt and tool configuration's cost, cache share, tool errors and corrections, and what changed." },
];

function Nav() {
	const search = useFilterSearch();
	return (
		<nav className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1" aria-label="Sections">
			{SECTIONS.map((section) => (
				<NavLink
					key={section.to}
					to={`${section.to}${search}`}
					end={section.end}
					className={({ isActive }) => cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition", isActive ? "bg-sky-500/15 text-sky-200" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100")}
				>
					{section.label}
				</NavLink>
			))}
		</nav>
	);
}

function Layout() {
	const { pathname } = useLocation();
	const base = `/${pathname.split("/")[1] ?? ""}`;
	const section = SECTIONS.find((s) => s.to === base) ?? SECTIONS[0]!;
	const detail = pathname.startsWith("/sessions/");
	return (
		<div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">
			<header className="mb-6">
				<div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-sky-300">
					<ChevronRight className="size-3" /> Pi harness
				</div>
				<h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{detail ? "Session" : (section.title ?? section.label)}</h1>
				<p className="mt-1 max-w-3xl text-sm text-slate-400">{detail ? "One session over time: requests, cache, compactions, pauses and subagents." : section.description}</p>
			</header>
			<Nav />
			<FilterBar withSession={!detail} />
			<Outlet />
		</div>
	);
}

export function App() {
	const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
	return (
		<QueryClientProvider client={client}>
			<BrowserRouter>
				<Routes>
					<Route element={<Layout />}>
						<Route index element={<OverviewView />} />
						<Route path="drivers" element={<DriversView />} />
						<Route path="context" element={<ContextView />} />
						<Route path="sessions" element={<SessionsView />} />
						<Route path="sessions/*" element={<SessionDetailView />} />
						<Route path="waste" element={<WasteView />} />
						<Route path="subagents" element={<SubagentsView />} />
						<Route path="versions" element={<VersionsView />} />
						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			</BrowserRouter>
		</QueryClientProvider>
	);
}
