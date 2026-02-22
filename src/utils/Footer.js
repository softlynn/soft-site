import { Box, Stack, SvgIcon, Typography } from "@mui/material";
import GitInfo from "react-git-info/macro";
import CustomLink from "./CustomLink";
import { BRAND_NAME, GITHUB_REPO } from "../config/site";

const gitInfo = GitInfo();
const COPYRIGHT_YEAR = 2026;
const OP_ARCHIVES_URL = "https://github.com/OP-Archives";
const TYPEGPU_REPO_URL = "https://github.com/software-mansion/TypeGPU";
const TYPEGPU_DOCS_URL = "https://docs.swmansion.com/TypeGPU/examples";

function TypeGpuMark(props) {
  return (
    <SvgIcon viewBox="0 0 24 24" fontSize="inherit" {...props}>
      <path
        d="M4 6.5c0-1.38 1.12-2.5 2.5-2.5h11C18.88 4 20 5.12 20 6.5v11c0 1.38-1.12 2.5-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z"
        fill="currentColor"
        opacity="0.14"
      />
      <path d="M7 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16.5" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.5 9.5v-2M14.3 10.6l-1.4-1.4M18.7 10.6l1.4-1.4M19 12h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </SvgIcon>
  );
}

export default function Footer() {
  const brandLabel = String(BRAND_NAME || "Softu").toLowerCase();

  return (
    <Box
      component="footer"
      className="soft-glass soft-surface-float"
      sx={{
        mt: 3,
        mx: { xs: 1.5, sm: 2.5 },
        mb: 2,
        px: { xs: 1.5, sm: 2.5 },
        py: 1.3,
        borderRadius: "20px",
      }}
    >
      <Stack direction={{ xs: "column", md: "row" }} spacing={{ xs: 0.75, md: 2 }} alignItems={{ xs: "flex-start", md: "center" }} justifyContent="space-between">
        <Stack direction={{ xs: "column", sm: "row" }} spacing={{ xs: 0.35, sm: 1.5 }} alignItems={{ xs: "flex-start", sm: "center" }} sx={{ minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700, letterSpacing: "0.02em" }}>
            {`${brandLabel} © ${COPYRIGHT_YEAR}`}
          </Typography>
          <CustomLink href={OP_ARCHIVES_URL} rel="noopener noreferrer" target="_blank">
            <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
              Backend by OP
            </Typography>
          </CustomLink>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <CustomLink href={TYPEGPU_REPO_URL} rel="noopener noreferrer" target="_blank">
              <Stack direction="row" spacing={0.5} alignItems="center">
                <TypeGpuMark sx={{ fontSize: 16, color: "#395473" }} />
                <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
                  made with TypeGPU
                </Typography>
              </Stack>
            </CustomLink>
            <CustomLink href={TYPEGPU_DOCS_URL} rel="noopener noreferrer" target="_blank">
              <Typography variant="caption" sx={{ color: "text.secondary", opacity: 0.72 }}>
                docs
              </Typography>
            </CustomLink>
          </Stack>
        </Stack>

        {GITHUB_REPO && (
          <CustomLink href={`${GITHUB_REPO}/commit/${gitInfo.commit.shortHash}`} rel="noopener noreferrer" target="_blank">
            <Typography variant="caption" sx={{ color: "text.secondary", opacity: 0.44, fontSize: "0.68rem", letterSpacing: "0.04em" }}>
              {`build ${gitInfo.commit.shortHash}`}
            </Typography>
          </CustomLink>
        )}
      </Stack>
    </Box>
  );
}
