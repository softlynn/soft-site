import { forwardRef } from "react";
import { styled, Link } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";

const CustomLink = styled(
  forwardRef(function CustomLinkBase(props, ref) {
    const { href, ...rest } = props;
    const isInternalLink = typeof href === "string" && href.startsWith("/");

    if (isInternalLink) {
      return <Link component={RouterLink} to={href} ref={ref} {...rest} />;
    }

    return <Link href={href} ref={ref} {...rest} />;
  })
)`
  display: inline-flex;
  align-items: center;
  color: inherit;
  transition: opacity 160ms ease, transform 160ms ease, filter 160ms ease;

  &:hover {
    opacity: 0.88;
    transform: translateY(-1px);
    filter: saturate(1.05);
  }
`;

export default CustomLink;
