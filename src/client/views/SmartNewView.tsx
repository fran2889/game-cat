import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { validateRules } from "../../shared/rules.ts";
import { SmartEditor } from "../components/SmartEditor.tsx";
import { NEW_COLLECTION_NAME, readDraftHandoff } from "../smart-handoff.ts";
import { useSmartCollections } from "../smart-collections-context.tsx";

/**
 * `/smart/new`: the explicit first Save path (§7.4).
 *
 * The draft may arrive from "New from selection"; a successful create replaces
 * `/smart/new` with `/smart/{id}` so the saved editor takes over.
 */
export function SmartNewView() {
  const location = useLocation();
  const navigate = useNavigate();
  const { reload } = useSmartCollections();
  const handoff = useMemo(() => readDraftHandoff(location.state), [location.state]);
  const initialRules = useMemo(() => {
    if (handoff === null) {
      return [];
    }
    const validated = validateRules(handoff.rules);
    return Object.keys(validated.fieldErrors).length === 0 ? validated.rules : [];
  }, [handoff]);

  return (
    <SmartEditor
      collection={null}
      initialName={handoff?.name ?? NEW_COLLECTION_NAME}
      initialRules={initialRules}
      onSaved={(saved) => {
        void reload();
        navigate(`/smart/${encodeURIComponent(saved.id)}`, { replace: true });
      }}
    />
  );
}
