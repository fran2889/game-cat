import { Button, Paper, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";

export function NotFoundView() {
  return (
    <Paper
      component="section"
      className="placeholder"
      aria-labelledby="not-found-heading"
      p="lg"
      radius="lg"
      withBorder
    >
      <Stack gap="sm">
        <Text className="placeholder-kicker" size="xs" c="gray.5" tt="uppercase" fw={700}>
          Not found
        </Text>
        <Title order={2} id="not-found-heading">
          Not found
        </Title>
        <Text c="gray.5">
          That route or Game does not exist. Check the address, or return to the Library.
        </Text>
        <Button component={Link} to="/">
          Back to Library
        </Button>
      </Stack>
    </Paper>
  );
}
