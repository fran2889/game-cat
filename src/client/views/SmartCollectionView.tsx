import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Paper, Stack, Text, Title } from "@mantine/core";
import { ApiError, smartCollectionQueryOptions } from "../api.ts";
import { GameGridSkeleton } from "../components/GameGridSkeleton.tsx";
import { SmartEditor } from "../components/SmartEditor.tsx";
import { useSmartCollections } from "../smart-collections-context.tsx";

/**
 * `/smart/{id}`: the saved editor. Name and Rule edits autosave after the
 * explicit first save, and Delete returns to the Library.
 */
export function SmartCollectionView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { reload, remove } = useSmartCollections();
  const queryOptions = smartCollectionQueryOptions(id);
  const collectionQuery = useQuery({ ...queryOptions, enabled: id !== "" });
  const collection = collectionQuery.data ?? null;
  const missing =
    id === "" ||
    (collectionQuery.error instanceof ApiError && collectionQuery.error.status === 404);
  const error =
    collectionQuery.error !== null && !(collectionQuery.error instanceof ApiError)
      ? collectionQuery.error.message
      : collectionQuery.error instanceof ApiError && collectionQuery.error.status !== 404
        ? collectionQuery.error.message
        : null;

  if (missing) {
    return (
      <Paper
        component="section"
        aria-labelledby="smart-collection-missing"
        p="lg"
        radius="lg"
        withBorder
      >
        <Stack gap="sm">
          <Title order={2} id="smart-collection-missing">
            Smart Collection not found.
          </Title>
          <Text c="gray.5">
            It may have been deleted. Choose another Collection from the sidebar.
          </Text>
          <Box>
            <Button component={Link} to="/" variant="default">
              Back to the Library
            </Button>
          </Box>
        </Stack>
      </Paper>
    );
  }

  if (error !== null) {
    return (
      <Alert color="red" role="alert" title="Cannot load this Smart Collection.">
        <Stack gap="sm" align="flex-start">
          <Text size="sm">{error}</Text>
          <Button variant="default" onClick={() => void collectionQuery.refetch()}>
            Retry
          </Button>
        </Stack>
      </Alert>
    );
  }

  if (collection === null) {
    return <GameGridSkeleton label="Loading the Smart Collection" />;
  }

  return (
    <SmartEditor
      key={collection.id}
      collection={collection}
      onSaved={(saved) => {
        queryClient.setQueryData(queryOptions.queryKey, saved);
        void reload();
      }}
      onDeleted={() => {
        remove(collection.id);
        queryClient.removeQueries({ queryKey: queryOptions.queryKey });
        void reload();
        navigate("/");
      }}
    />
  );
}
