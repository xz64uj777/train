import { createFileRoute } from "@tanstack/react-router";
import { ValleyApp } from "@/components/valley-app";

export const Route = createFileRoute("/")({ component: ValleyApp });
