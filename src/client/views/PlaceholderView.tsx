import type { ReactNode } from "react";
import { Paper, Stack, Text, Title } from "@mantine/core";

export interface PlaceholderViewProps {
  kicker: string;
  title: string;
  description: string;
  children?: ReactNode;
}

export function PlaceholderView({ kicker, title, description, children }: PlaceholderViewProps) {
  return (
    <Paper
      component="section"
      className="placeholder"
      aria-labelledby="placeholder-heading"
      p="lg"
      radius="lg"
      withBorder
    >
      <Stack gap="sm">
        <Text className="placeholder-kicker" size="xs" c="gray.5" tt="uppercase" fw={700}>
          {kicker}
        </Text>
        <Title order={2} id="placeholder-heading">
          {title}
        </Title>
        <Text c="gray.5">{description}</Text>
        {children}
      </Stack>
    </Paper>
  );
}
