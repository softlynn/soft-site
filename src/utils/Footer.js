import { styled, Typography, Box } from "@mui/material";
import CustomLink from "./CustomLink";
import GitInfo from 'react-git-info/macro';
import { BRAND_NAME, FOOTER_CREDIT, FOOTER_CREDIT_URL, GITHUB_REPO } from "../config/site";

const gitInfo = GitInfo();
const COPYRIGHT_YEAR = 2026;

const Footer = styled((props) => (
  <Box {...props}>
    <Box sx={{ mt: 0.5 }}>
      <Typography variant="caption" color="textSecondary">
        {`${BRAND_NAME} © ${COPYRIGHT_YEAR}`}
      </Typography>
    </Box>
    {FOOTER_CREDIT && (
      <>
        {FOOTER_CREDIT_URL ? (
          <CustomLink href={FOOTER_CREDIT_URL} rel="noopener noreferrer" target="_blank">
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", mt: 0.25 }}>
              <Typography variant="caption" color="textSecondary">
                {FOOTER_CREDIT}
              </Typography>
            </Box>
          </CustomLink>
        ) : (
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", mt: 0.25 }}>
            <Typography variant="caption" color="textSecondary">
              {FOOTER_CREDIT}
            </Typography>
          </Box>
        )}
      </>
    )}
    {GITHUB_REPO && (
      <CustomLink href={`${GITHUB_REPO}/commit/${gitInfo.commit.shortHash}`} rel="noopener noreferrer" target="_blank">
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", mt: 0.25 }}>
          <Typography variant="caption" color="textSecondary">
            {`Build Version: ${gitInfo.commit.shortHash}`}
          </Typography>
        </Box>
      </CustomLink>
    )}
  </Box>
))`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
`;

export default Footer;
