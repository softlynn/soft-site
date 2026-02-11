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
  &:hover {
    opacity: 50%;
  }
`;

export default CustomLink;
